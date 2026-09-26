interface Env {
  DB: D1Database;
  AI: Ai;
  ASSETS: Fetcher;
}

const COOKIE = "homeworktrack_session";
const SESSION_DAYS = 7;

function json(data: unknown, status = 200, headers: Record<string,string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers }
  });
}

function hex(bytes: ArrayBuffer) {
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function randomBytes(n = 32) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return a;
}

async function derive(password: string, saltHex: string) {
  const salt = new Uint8Array(saltHex.match(/.{2}/g)!.map(x => parseInt(x, 16)));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 120000, hash: "SHA-256" },
    key,
    256
  );
  return hex(bits);
}

async function sha256(value: string) {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

function cookieToken(request: Request) {
  const raw = request.headers.get("Cookie") || "";
  const m = raw.match(new RegExp(`${COOKIE}=([^;]+)`));
  return m?.[1] || null;
}

async function currentTeacher(request: Request, env: Env) {
  const token = cookieToken(request);
  if (!token) return null;
  const tokenHash = await sha256(token);
  const row = await env.DB.prepare(`
    SELECT t.id, t.email, t.display_name, t.role
    FROM sessions s JOIN teachers t ON t.id=s.teacher_id
    WHERE s.token_hash=? AND s.expires_at > datetime('now') AND t.active=1
  `).bind(tokenHash).first<any>();
  return row || null;
}

function sessionCookie(token: string) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}

function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

async function audit(env: Env, actor: any, action: string, entityType = "", entityId: number | null = null, details: any = {}) {
  await env.DB.prepare(`
    INSERT INTO audit_log(actor_email, action, entity_type, entity_id, details_json)
    VALUES (?, ?, ?, ?, ?)
  `).bind(actor?.email || null, action, entityType, entityId, JSON.stringify(details)).run();
}

async function api(request: Request, env: Env) {
  const url = new URL(request.url);

  if (url.pathname === "/api/health") return json({ ok: true, app: "HomeworkTrack Pro v5" });

  if (url.pathname === "/api/setup/status" && request.method === "GET") {
    const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM teachers").first<any>();
    return json({ needsSetup: Number(row?.count || 0) === 0 });
  }

  if (url.pathname === "/api/setup" && request.method === "POST") {
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM teachers").first<any>();
    if (Number(count?.count || 0) !== 0) return json({ error: "Setup has already been completed." }, 409);

    const body = await request.json<any>();
    const email = String(body.email || "").trim().toLowerCase();
    const name = String(body.display_name || "").trim();
    const password = String(body.password || "");

    if (!email || !name || password.length < 8) {
      return json({ error: "Enter a name, email and a password of at least 8 characters." }, 400);
    }

    const salt = hex(randomBytes(16));
    const hash = await derive(password, salt);
    await env.DB.prepare(`
      INSERT INTO teachers(email, display_name, role, password_hash, password_salt)
      VALUES (?, ?, 'admin', ?, ?)
    `).bind(email, name, hash, salt).run();

    return json({ ok: true, message: "Admin account created. You can now sign in." }, 201);
  }

  if (url.pathname === "/api/login" && request.method === "POST") {
    const body = await request.json<any>();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");

    const teacher = await env.DB.prepare(`
      SELECT id, email, display_name, role, password_hash, password_salt
      FROM teachers WHERE email=? AND active=1
    `).bind(email).first<any>();

    if (!teacher) return json({ error: "Incorrect email or password." }, 401);

    const hash = await derive(password, teacher.password_salt);
    if (hash !== teacher.password_hash) return json({ error: "Incorrect email or password." }, 401);

    const token = hex(randomBytes(32));
    const tokenHash = await sha256(token);
    await env.DB.prepare(`
      INSERT INTO sessions(teacher_id, token_hash, expires_at)
      VALUES (?, ?, datetime('now', '+${SESSION_DAYS} days'))
    `).bind(teacher.id, tokenHash).run();

    await audit(env, teacher, "login");
    return json(
      { ok: true, teacher: { id: teacher.id, email: teacher.email, display_name: teacher.display_name, role: teacher.role } },
      200,
      { "Set-Cookie": sessionCookie(token) }
    );
  }

  if (url.pathname === "/api/logout" && request.method === "POST") {
    const teacher = await currentTeacher(request, env);
    const token = cookieToken(request);
    if (token) {
      await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(await sha256(token)).run();
    }
    if (teacher) await audit(env, teacher, "logout");
    return json({ ok: true }, 200, { "Set-Cookie": clearCookie() });
  }

  const teacher = await currentTeacher(request, env);
  if (!teacher) return json({ error: "Staff login required." }, 401);

  if (url.pathname === "/api/me" && request.method === "GET") {
    return json({ teacher });
  }

  if (url.pathname === "/api/dashboard" && request.method === "GET") {
    const [classes, students, homework, incomplete, detentions] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) AS n FROM classes WHERE teacher_id=?").bind(teacher.id).first<any>(),
      env.DB.prepare(`
        SELECT COUNT(*) AS n FROM students s JOIN classes c ON c.id=s.class_id
        WHERE c.teacher_id=? AND s.active=1
      `).bind(teacher.id).first<any>(),
      env.DB.prepare("SELECT COUNT(*) AS n FROM homework WHERE created_by=?").bind(teacher.id).first<any>(),
      env.DB.prepare(`
        SELECT COUNT(*) AS n FROM submissions sub
        JOIN homework h ON h.id=sub.homework_id
        WHERE h.created_by=? AND sub.status IN ('incomplete','late')
      `).bind(teacher.id).first<any>(),
      env.DB.prepare(`
        SELECT COUNT(*) AS n FROM detentions d
        WHERE d.created_by=? AND d.status IN ('pending_review','approved')
      `).bind(teacher.id).first<any>()
    ]);
    return json({
      classes: Number(classes?.n || 0),
      students: Number(students?.n || 0),
      homework: Number(homework?.n || 0),
      incomplete: Number(incomplete?.n || 0),
      detentions: Number(detentions?.n || 0)
    });
  }

  if (url.pathname === "/api/detentions" && request.method === "GET") {
    const rows = await env.DB.prepare(`
      SELECT d.id, d.reason, d.status, d.schedule, d.created_at,
             s.first_name || ' ' || s.last_name AS student_name,
             h.title AS homework_title
      FROM detentions d
      JOIN students s ON s.id=d.student_id
      LEFT JOIN homework h ON h.id=d.homework_id
      WHERE d.created_by=?
      ORDER BY d.created_at DESC
      LIMIT 100
    `).bind(teacher.id).all();
    return json(rows.results);
  }

  if (url.pathname === "/api/detentions/review" && request.method === "POST") {
    const body = await request.json<any>();
    const id = Number(body.id);
    const action = String(body.action || "");
    const allowed = ["approve", "cancel", "complete"];
    if (!allowed.includes(action)) return json({ error: "Invalid action." }, 400);

    const status = action === "approve" ? "approved" : action === "cancel" ? "cancelled" : "completed";
    const result = await env.DB.prepare(`
      UPDATE detentions
      SET status=?, reviewed_by=?, reviewed_at=datetime('now')
      WHERE id=? AND created_by=?
    `).bind(status, teacher.id, id, teacher.id).run();

    if (!result.meta.changes) return json({ error: "Detention not found." }, 404);
    await audit(env, teacher, `detention_${action}`, "detention", id);
    return json({ ok: true });
  }

  if (url.pathname === "/api/ai/insights" && request.method === "POST") {
    const body = await request.json<any>();
    const prompt = `You are a school-workflow assistant. Give concise, neutral classroom-management insights from this aggregated data. Never decide punishments and never identify individual pupils. Recommend teacher review. Data: ${JSON.stringify(body)}`;
    const result = await env.AI.run("@cf/google/gemma-4-26b-a4b-it", {
      messages: [{ role: "user", content: prompt }],
      chat_template_kwargs: { enable_thinking: false }
    });
    return json({ insight: result });
  }

  return json({ error: "Not found." }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await api(request, env);
      } catch (e) {
        console.error(e);
        return json({ error: "Server error." }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  }
};
