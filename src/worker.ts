type Env={DB:D1Database;AI:Ai;ASSETS:Fetcher};
const json=(x:unknown,s=200)=>new Response(JSON.stringify(x),{status:s,headers:{"content-type":"application/json"}});
const accessEmail=(r:Request)=>r.headers.get("Cf-Access-Authenticated-User-Email")?.trim().toLowerCase()||null;
async function teacher(r:Request,e:Env){const email=accessEmail(r);if(!email)return null;return e.DB.prepare("SELECT id,email,display_name,role FROM teachers WHERE lower(email)=? AND active=1").bind(email).first();}
async function audit(e:Env,t:any,a:string,id?:number){await e.DB.prepare("INSERT INTO audit_log(actor_email,action,entity_type,entity_id) VALUES(?,?,?,?)").bind(t?.email||null,a,id?"detention":null,id||null).run();}
export default {async fetch(r:Request,e:Env){
 const u=new URL(r.url);
 if(u.pathname==="/api/health")return json({ok:true,app:"HomeworkTrack Pro v4",version:"4.0.0"});
 if(u.pathname==="/api/me"){const t=await teacher(r,e);return t?json({authenticated:true,teacher:t}):json({authenticated:false},401);}
 const t=await teacher(r,e); if(!t){if(u.pathname.startsWith("/api/"))return json({error:"Teacher authentication required."},401);return e.ASSETS.fetch(r);}
 if(u.pathname==="/api/dashboard"){const q=await Promise.all([
 e.DB.prepare("SELECT COUNT(*) n FROM classes WHERE teacher_id=?").bind((t as any).id).first<any>(),
 e.DB.prepare("SELECT COUNT(*) n FROM students WHERE active=1 AND class_id IN (SELECT id FROM classes WHERE teacher_id=?)").bind((t as any).id).first<any>(),
 e.DB.prepare("SELECT COUNT(*) n FROM homework WHERE class_id IN (SELECT id FROM classes WHERE teacher_id=?)").bind((t as any).id).first<any>(),
 e.DB.prepare("SELECT COUNT(*) n FROM submissions s JOIN homework h ON h.id=s.homework_id JOIN classes c ON c.id=h.class_id WHERE c.teacher_id=? AND s.status='incomplete'").bind((t as any).id).first<any>(),
 e.DB.prepare("SELECT COUNT(*) n FROM detentions d JOIN students s ON s.id=d.student_id JOIN classes c ON c.id=s.class_id WHERE c.teacher_id=? AND d.status IN ('pending_review','approved')").bind((t as any).id).first<any>()]);return json({classes:q[0]?.n||0,students:q[1]?.n||0,homework:q[2]?.n||0,incomplete:q[3]?.n||0,detentions:q[4]?.n||0});}
 if(u.pathname==="/api/detentions"&&r.method==="GET"){const x=await e.DB.prepare("SELECT d.*,s.first_name,s.last_name,h.title homework_title FROM detentions d JOIN students s ON s.id=d.student_id LEFT JOIN homework h ON h.id=d.homework_id JOIN classes c ON c.id=s.class_id WHERE c.teacher_id=? ORDER BY d.created_at DESC").bind((t as any).id).all();return json(x.results);}
 if(u.pathname==="/api/ai/insights"&&r.method==="POST"){const b:any=await r.json().catch(()=>({}));const x=await e.AI.run("@cf/google/gemma-4-26b-a4b-it",{messages:[{role:"system",content:"You are a neutral school workflow assistant. Do not make disciplinary decisions. Give concise practical observations and recommend teacher review. Avoid unnecessary pupil personal data."},{role:"user",content:String(b.prompt||"Give three neutral classroom workflow observations.")}],chat_template_kwargs:{enable_thinking:false}});await audit(e,t,"ai_insight_generated");return json(x);}
 if(u.pathname==="/api/detentions/review"&&r.method==="POST"){if(!["teacher","pastoral","head_of_year","admin"].includes((t as any).role))return json({error:"Insufficient role."},403);const b:any=await r.json();if(!b.id||!["approved","cancelled","completed"].includes(b.status))return json({error:"Invalid review request."},400);await e.DB.prepare("UPDATE detentions SET status=?,reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=?").bind(b.status,(t as any).id,b.id).run();await audit(e,t,"detention_"+b.status,b.id);return json({ok:true});}
 return e.ASSETS.fetch(r);
}} satisfies ExportedHandler<Env>;