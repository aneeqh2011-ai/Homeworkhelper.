interface Env {
  DB: D1Database;
  ASSETS: Fetcher;

  ADMIN1_PASSWORD: string;
  ADMIN2_PASSWORD: string;
}

const SESSION_DAYS = 7;

const ADMIN_ACCOUNTS = [
  {
    username: "admin1",
    email: "admin1@homeworktrack.local",
    name: "Admin 1",
    passwordSecret: "ADMIN1_PASSWORD"
  },
  {
    username: "admin2",
    email: "admin2@homeworktrack.local",
    name: "Admin 2",
    passwordSecret: "ADMIN2_PASSWORD"
  }
];

function randomId(): string {
  return crypto.randomUUID();
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    }
  });
}

function getCookie(
  request: Request,
  name: string
): string | null {
  const cookie = request.headers.get("Cookie");

  if (!cookie) {
    return null;
  }

  for (const part of cookie.split(";")) {
    const [key, ...value] = part.trim().split("=");

    if (key === name) {
      return decodeURIComponent(value.join("="));
    }
  }

  return null;
}

function createSessionCookie(
  sessionId: string
): string {
  return [
    `session=${encodeURIComponent(sessionId)}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${SESSION_DAYS * 24 * 60 * 60}`
  ].join("; ");
}

function clearSessionCookie(): string {
  return [
    "session=",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Path=/",
    "Max-Age=0"
  ].join("; ");
}

function base64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);

  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

async function hashPassword(
  password: string
): Promise<string> {
  const encoder = new TextEncoder();

  const salt =
    crypto.getRandomValues(
      new Uint8Array(16)
    );

  const key =
    await crypto.subtle.importKey(
      "raw",
      encoder.encode(password),
      {
        name: "PBKDF2"
      },
      false,
      ["deriveBits"]
    );

  const derived =
    await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt,
        iterations: 100000,
        hash: "SHA-256"
      },
      key,
      256
    );

  return [
    "pbkdf2",
    "100000",
    base64(salt.buffer),
    base64(derived)
  ].join("$");
}

async function verifyPassword(
  password: string,
  stored: string
): Promise<boolean> {
  const parts = stored.split("$");

  if (parts.length !== 4) {
    return false;
  }

  const iterations = Number(parts[1]);

  const salt = Uint8Array.from(
    atob(parts[2]),
    (c) => c.charCodeAt(0)
  );

  const expected = Uint8Array.from(
    atob(parts[3]),
    (c) => c.charCodeAt(0)
  );

  const encoder = new TextEncoder();

  const key =
    await crypto.subtle.importKey(
      "raw",
      encoder.encode(password),
      {
        name: "PBKDF2"
      },
      false,
      ["deriveBits"]
    );

  const derived =
    await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt,
        iterations,
        hash: "SHA-256"
      },
      key,
      256
    );

  const actual =
    new Uint8Array(derived);

  if (actual.length !== expected.length) {
    return false;
  }

  let difference = 0;

  for (let i = 0; i < actual.length; i++) {
    difference |=
      actual[i] ^ expected[i];
  }

  return difference === 0;
}

function validUsername(
  username: string
): boolean {
  return /^[a-zA-Z0-9_]{3,30}$/.test(username);
}

function validEmail(
  email: string
): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function createAdminIfMissing(
  env: Env,
  account: {
    username: string;
    email: string;
    name: string;
    passwordSecret: string;
  }
) {
  const existing =
    await env.DB
      .prepare(`
        SELECT id
        FROM users
        WHERE username = ?
           OR email = ?
      `)
      .bind(
        account.username,
        account.email
      )
      .first();

  if (existing) {
    return;
  }

  const password =
    account.passwordSecret === "ADMIN1_PASSWORD"
      ? env.ADMIN1_PASSWORD
      : env.ADMIN2_PASSWORD;

  if (!password) {
    return;
  }

  const passwordHash =
    await hashPassword(password);

  await env.DB
    .prepare(`
      INSERT INTO users
      (
        id,
        username,
        email,
        password_hash,
        role,
        name
      )
      VALUES (?, ?, ?, ?, 'admin', ?)
    `)
    .bind(
      randomId(),
      account.username,
      account.email,
      passwordHash,
      account.name
    )
    .run();
}

async function setupAdmins(
  env: Env
) {
  for (const account of ADMIN_ACCOUNTS) {
    await createAdminIfMissing(
      env,
      account
    );
  }
}

async function getCurrentUser(
  request: Request,
  env: Env
) {
  const sessionId =
    getCookie(request, "session");

  if (!sessionId) {
    return null;
  }

  const session =
    await env.DB
      .prepare(`
        SELECT
          sessions.id,
          sessions.expires_at,
          users.id AS user_id,
          users.username,
          users.email,
          users.name,
          users.role
        FROM sessions
        JOIN users
          ON users.id = sessions.user_id
        WHERE sessions.id = ?
          AND sessions.expires_at > datetime('now')
      `)
      .bind(sessionId)
      .first<{
        id: string;
        expires_at: string;
        user_id: string;
        username: string;
        email: string;
        name: string;
        role: string;
      }>();

  return session || null;
}

async function login(
  request: Request,
  env: Env
): Promise<Response> {
  const body =
    await request.json() as {
      identifier?: string;
      password?: string;
    };

  const identifier =
    body.identifier
      ?.trim()
      .toLowerCase();

  const password =
    body.password;

  if (!identifier || !password) {
    return json(
      {
        success: false,
        error:
          "Username/email and password are required."
      },
      400
    );
  }

  const user =
    await env.DB
      .prepare(`
        SELECT
          id,
          username,
          email,
          password_hash,
          role,
          name
        FROM users
        WHERE LOWER(username) = ?
           OR LOWER(email) = ?
      `)
      .bind(
        identifier,
        identifier
      )
      .first<{
        id: string;
        username: string;
        email: string;
        password_hash: string;
        role: string;
        name: string;
      }>();

  if (!user) {
    return json(
      {
        success: false,
        error:
          "Invalid username/email or password."
      },
      401
    );
  }

  const valid =
    await verifyPassword(
      password,
      user.password_hash
    );

  if (!valid) {
    return json(
      {
        success: false,
        error:
          "Invalid username/email or password."
      },
      401
    );
  }

  const sessionId =
    randomId();

  const expires =
    new Date(
      Date.now() +
      SESSION_DAYS *
      24 *
      60 *
      60 *
      1000
    ).toISOString();

  await env.DB
    .prepare(`
      INSERT INTO sessions
      (
        id,
        user_id,
        expires_at
      )
      VALUES (?, ?, ?)
    `)
    .bind(
      sessionId,
      user.id,
      expires
    )
    .run();

  return new Response(
    JSON.stringify({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        name: user.name,
        role: user.role
      }
    }),
    {
      status: 200,
      headers: {
        "Content-Type":
          "application/json",
        "Cache-Control":
          "no-store",
        "Set-Cookie":
          createSessionCookie(
            sessionId
          )
      }
    }
  );
}

async function register(
  request: Request,
  env: Env
): Promise<Response> {
  const body =
    await request.json() as {
      username?: string;
      email?: string;
      password?: string;
      name?: string;
    };

  const username =
    body.username?.trim();

  const email =
    body.email
      ?.trim()
      .toLowerCase();

  const password =
    body.password;

  const name =
    body.name?.trim();

  if (
    !username ||
    !email ||
    !password ||
    !name
  ) {
    return json(
      {
        success: false,
        error:
          "Name, username, email and password are required."
      },
      400
    );
  }

  if (!validUsername(username)) {
    return json(
      {
        success: false,
        error:
          "Username must be 3-30 characters and use only letters, numbers or underscores."
      },
      400
    );
  }

  if (!validEmail(email)) {
    return json(
      {
        success: false,
        error:
          "Please enter a valid email address."
      },
      400
    );
  }

  if (password.length < 8) {
    return json(
      {
        success: false,
        error:
          "Password must be at least 8 characters."
      },
      400
    );
  }

  const existing =
    await env.DB
      .prepare(`
        SELECT id
        FROM users
        WHERE LOWER(username) = ?
           OR LOWER(email) = ?
      `)
      .bind(
        username.toLowerCase(),
        email
      )
      .first();

  if (existing) {
    return json(
      {
        success: false,
        error:
          "That username or email is already registered."
      },
      409
    );
  }

  const passwordHash =
    await hashPassword(password);

  await env.DB
    .prepare(`
      INSERT INTO users
      (
        id,
        username,
        email,
        password_hash,
        role,
        name
      )
      VALUES (?, ?, ?, ?, 'student', ?)
    `)
    .bind(
      randomId(),
      username,
      email,
      passwordHash,
      name
    )
    .run();

  return json({
    success: true,
    message:
      "Account created successfully."
  });
}

async function logout(
  request: Request,
  env: Env
): Promise<Response> {
  const sessionId =
    getCookie(
      request,
      "session"
    );

  if (sessionId) {
    await env.DB
      .prepare(
        "DELETE FROM sessions WHERE id = ?"
      )
      .bind(sessionId)
      .run();
  }

  return new Response(
    JSON.stringify({
      success: true
    }),
    {
      status: 200,
      headers: {
        "Content-Type":
          "application/json",
        "Set-Cookie":
          clearSessionCookie()
      }
    }
  );
}

async function me(
  request: Request,
  env: Env
): Promise<Response> {
  const user =
    await getCurrentUser(
      request,
      env
    );

  if (!user) {
    return json({
      loggedIn: false
    });
  }

  return json({
    loggedIn: true,
    user: {
      id: user.user_id,
      username: user.username,
      email: user.email,
      name: user.name,
      role: user.role
    }
  });
}

async function admin(
  request: Request,
  env: Env
): Promise<Response> {
  const user =
    await getCurrentUser(
      request,
      env
    );

  if (!user) {
    return json(
      {
        success: false,
        error:
          "You must be logged in."
      },
      401
    );
  }

  if (user.role !== "admin") {
    return json(
      {
        success: false,
        error:
          "Administrator access required."
      },
      403
    );
  }

  return json({
    success: true,
    message:
      "Welcome to the HomeworkTrack PRO admin dashboard.",
    user: {
      id: user.user_id,
      username: user.username,
      email: user.email,
      name: user.name,
      role: user.role
    }
  });
}

export default {
  async fetch(
    request: Request,
    env: Env
  ): Promise<Response> {

    await setupAdmins(env);

    const url =
      new URL(request.url);

    if (
      url.pathname === "/api/login" &&
      request.method === "POST"
    ) {
      return login(
        request,
        env
      );
    }

    if (
      url.pathname === "/api/register" &&
      request.method === "POST"
    ) {
      return register(
        request,
        env
      );
    }

    if (
      url.pathname === "/api/logout" &&
      request.method === "POST"
    ) {
      return logout(
        request,
        env
      );
    }

    if (
      url.pathname === "/api/me" &&
      request.method === "GET"
    ) {
      return me(
        request,
        env
      );
    }

    if (
      url.pathname === "/api/admin" &&
      request.method === "GET"
    ) {
      return admin(
        request,
        env
      );
    }

    return env.ASSETS.fetch(
      request
    );
  }
};
