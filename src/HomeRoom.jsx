import React, { useState, useEffect } from "react";
import { createClient } from "@supabase/supabase-js";

// ─── Supabase Client ──────────────────────────────────────────────────────────
const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

// ─── useAuth Hook ─────────────────────────────────────────────────────────────
function useAuth() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) setUser(formatUser(session.user));
      setLoading(false);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ? formatUser(session.user) : null);
    });
    return () => subscription.unsubscribe();
  }, []);

  const signUp = async (email, password, name) => {
    const { data, error } = await supabase.auth.signUp({
      email, password, options: { data: { name } }
    });
    if (error) throw error;
    // Immediately sign in after signup since email confirm is off
    if (data?.user) {
      const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({ email, password });
      if (signInError) throw signInError;
      return signInData;
    }
    return data;
  };

  const signIn = async (email, password) => {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
  };

  const signOut = async () => { await supabase.auth.signOut(); };

  return { user, loading, signUp, signIn, signOut };
}

function formatUser(u) {
  return { id: u.id, email: u.email, name: u.user_metadata?.name || u.email.split("@")[0] };
}

// ─── useHomeRoom Hook ─────────────────────────────────────────────────────────
function useHomeRoom(userId) {
  const [kids, setKids] = useState([]);
  const [semester, setSemester] = useState(null);
  const [history, setHistory] = useState([]);
  const [lessonPlans, setLessonPlans] = useState([]);
  const [dataLoading, setDataLoading] = useState(true);
  const [setupDone, setSetupDone] = useState(false);

  useEffect(() => {
    if (!userId) { setDataLoading(false); return; }
    loadAll();
  }, [userId]);

  const loadAll = async () => {
    setDataLoading(true);
    try { await Promise.all([loadKids(), loadSemester(), loadHistory(), loadLessonPlans()]); }
    finally { setDataLoading(false); }
  };

  const loadLessonPlans = async () => {
    const { data, error } = await supabase
      .from("lesson_plans")
      .select(`id, kid_id, week_start_date, created_at, kids ( name ), lesson_plan_items ( id, status )`)
      .eq("user_id", userId)
      .order("week_start_date", { ascending: false });
    if (error) { console.error("loadLessonPlans:", error); return; }
    setLessonPlans((data || []).map(p => {
      const items = p.lesson_plan_items || [];
      const counts = items.reduce((acc, it) => {
        const s = it.status || "todo";
        acc[s] = (acc[s] || 0) + 1;
        return acc;
      }, { todo: 0, assigned: 0, complete: 0 });
      return {
        id: p.id,
        kidId: p.kid_id,
        kidName: p.kids?.name || "Unknown",
        weekStartDate: p.week_start_date,
        total: items.length,
        ...counts
      };
    }));
  };

  const loadKids = async () => {
    const { data, error } = await supabase
      .from("kids")
      .select(`id, name, grade, learning_style, emoji, subjects(id, name, curriculum_weeks(week_number, topic, description))`)
      .eq("user_id", userId)
      .order("created_at");
    if (error) { console.error("loadKids:", error); return; }
    const shaped = (data || []).map(k => ({
      id: k.id, name: k.name, grade: k.grade,
      learningStyle: k.learning_style, emoji: k.emoji || "📚",
      subjects: (k.subjects || []).map(s => s.name),
      curriculumWeeks: (k.subjects || []).reduce((acc, s) => {
        if (s.curriculum_weeks?.length) {
          acc[s.name] = s.curriculum_weeks
            .sort((a, b) => a.week_number - b.week_number)
            .map(w => ({ week: w.week_number, topic: w.topic, description: w.description }));
        }
        return acc;
      }, {}),
      _subjectIds: (k.subjects || []).reduce((acc, s) => { acc[s.name] = s.id; return acc; }, {})
    }));
    setKids(shaped);
    if (shaped.length > 0) setSetupDone(true);
  };

  const saveKid = async ({ name, grade, learningStyle, subjects, emoji = "📚" }) => {
    const { data: kidRow, error: kidError } = await supabase
      .from("kids").insert({ user_id: userId, name, grade, learning_style: learningStyle, emoji })
      .select().single();
    if (kidError) throw kidError;
    const subjectRows = subjects.filter(s => s.trim()).map(s => ({ kid_id: kidRow.id, name: s.trim() }));
    if (subjectRows.length) {
      const { error } = await supabase.from("subjects").insert(subjectRows);
      if (error) throw error;
    }
    await loadKids();
    return kidRow.id;
  };

  const loadSemester = async () => {
    const { data, error } = await supabase
      .from("semesters").select("*").eq("user_id", userId).eq("is_active", true)
      .order("created_at", { ascending: false }).limit(1).single();
    if (error && error.code !== "PGRST116") { console.error("loadSemester:", error); return; }
    if (data) { setSemester({ start: data.start_date, end: data.end_date, id: data.id }); setSetupDone(true); }
  };

  const saveSemester = async ({ start, end }) => {
    await supabase.from("semesters").update({ is_active: false }).eq("user_id", userId).eq("is_active", true);
    const { data, error } = await supabase
      .from("semesters").insert({ user_id: userId, start_date: start, end_date: end, is_active: true })
      .select().single();
    if (error) throw error;
    setSemester({ start: data.start_date, end: data.end_date, id: data.id });
  };

  const saveCurriculumWeeks = async ({ kidId, subject, weeks }) => {
    const kid = kids.find(k => k.id === kidId);
    if (!kid) throw new Error("Kid not found");
    let subjectId = kid._subjectIds?.[subject];
    if (!subjectId) {
      const { data, error } = await supabase.from("subjects").insert({ kid_id: kidId, name: subject }).select().single();
      if (error) throw error;
      subjectId = data.id;
    }
    await supabase.from("curriculum_weeks").delete().eq("subject_id", subjectId);
    const { error } = await supabase.from("curriculum_weeks").insert(
      weeks.map(w => ({ subject_id: subjectId, week_number: w.week, topic: w.topic, description: w.description || null }))
    );
    if (error) throw error;
    await loadKids();
  };

  const loadHistory = async () => {
    const { data, error } = await supabase
      .from("generations").select("*").eq("user_id", userId)
      .order("created_at", { ascending: false }).limit(200);
    if (error) { console.error("loadHistory:", error); return; }
    setHistory((data || []).map(r => ({
      id: r.id, toolId: r.tool_id, toolTitle: r.tool_title, toolIcon: r.tool_icon,
      kidId: r.kid_id, kidName: r.kid_name, subject: r.subject_name,
      topic: r.topic, content: r.content, createdAt: r.created_at
    })));
  };

  const saveGeneration = async (entry) => {
    const { data, error } = await supabase.from("generations").insert({
      user_id: userId, kid_id: entry.kidId || null, kid_name: entry.kidName,
      subject_name: entry.subject, tool_id: entry.toolId, tool_title: entry.toolTitle,
      tool_icon: entry.toolIcon, topic: entry.topic, content: entry.content
    }).select().single();
    if (error) throw error;
    setHistory(prev => [{ ...entry, id: data.id, createdAt: data.created_at }, ...prev]);
  };

  const deleteGeneration = async (id) => {
    const { error } = await supabase.from("generations").delete().eq("id", id);
    if (error) throw error;
    setHistory(prev => prev.filter(h => h.id !== id));
  };

  const loadScheduleRules = async (kidId) => {
    const { data, error } = await supabase
      .from("kid_schedule_rules").select("*").eq("kid_id", kidId);
    if (error) { console.error("loadScheduleRules:", error); return { subjectDays: {}, specialRules: [] }; }
    const subjectDays = {};
    const specialRules = [];
    (data || []).forEach(r => {
      if (r.subject === "special") specialRules.push({ text: r.notes || "" });
      else subjectDays[r.subject] = r.days_of_week || [];
    });
    return { subjectDays, specialRules };
  };

  const loadLessonPlan = async ({ kidId, weekStartDate }) => {
    const { data: plan, error: planErr } = await supabase
      .from("lesson_plans").select("id")
      .eq("kid_id", kidId).eq("week_start_date", weekStartDate)
      .maybeSingle();
    if (planErr) { console.error("loadLessonPlan plan:", planErr); return { planId: null, items: [] }; }
    if (!plan) return { planId: null, items: [] };
    const { data: items, error: itemsErr } = await supabase
      .from("lesson_plan_items").select("*")
      .eq("plan_id", plan.id).order("created_at");
    if (itemsErr) { console.error("loadLessonPlan items:", itemsErr); return { planId: plan.id, items: [] }; }
    return { planId: plan.id, items: items || [] };
  };

  const assignLessonPlanItem = async (itemId) => {
    const { data, error } = await supabase
      .from("lesson_plan_items")
      .update({ status: "assigned", assigned_at: new Date().toISOString() })
      .eq("id", itemId)
      .select("status, assigned_at")
      .single();
    if (error) throw error;
    loadLessonPlans();
    return data;
  };

  const saveLessonPlan = async ({ kidId, weekStartDate, items }) => {
    const { error: delErr } = await supabase.from("lesson_plans")
      .delete().eq("kid_id", kidId).eq("week_start_date", weekStartDate);
    if (delErr) throw delErr;
    const { data: plan, error: planErr } = await supabase
      .from("lesson_plans")
      .insert({ user_id: userId, kid_id: kidId, week_start_date: weekStartDate })
      .select().single();
    if (planErr) throw planErr;
    if (!items.length) return { planId: plan.id, items: [] };
    const rows = items.map(it => ({
      plan_id: plan.id,
      day: it.day,
      subject: it.subject || null,
      task_title: it.task_title,
      content: it.content || null,
      status: "todo"
    }));
    const { data: inserted, error: itemsErr } = await supabase
      .from("lesson_plan_items").insert(rows).select();
    if (itemsErr) throw itemsErr;
    loadLessonPlans();
    return { planId: plan.id, items: inserted };
  };

  const saveScheduleRules = async ({ kidId, subjectDays, specialRules }) => {
    const { error: delError } = await supabase
      .from("kid_schedule_rules").delete().eq("kid_id", kidId);
    if (delError) throw delError;
    const rows = [
      ...Object.entries(subjectDays).map(([subject, days]) => ({
        kid_id: kidId, subject, days_of_week: days, notes: null
      })),
      ...specialRules.filter(r => r.text.trim()).map(r => ({
        kid_id: kidId, subject: "special", days_of_week: [], notes: r.text.trim()
      })),
    ];
    if (rows.length) {
      const { error } = await supabase.from("kid_schedule_rules").insert(rows);
      if (error) throw error;
    }
  };

  const completeSetup = async ({ kids: newKids, semesterDates }) => {
    for (const kid of newKids) await saveKid(kid);
    await saveSemester(semesterDates);
    setSetupDone(true);
  };

  return {
    kids, semester, history, lessonPlans, dataLoading, setupDone,
    saveKid, saveSemester, saveCurriculumWeeks,
    saveGeneration, deleteGeneration,
    loadScheduleRules, saveScheduleRules,
    loadLessonPlan, saveLessonPlan, assignLessonPlanItem,
    completeSetup, reload: loadAll
  };
}

// ─── Design Tokens ────────────────────────────────────────────────────────────
const styles = `
  @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,600;1,400&family=Dancing+Script:wght@600;700&family=Lato:wght@300;400;700&display=swap');

  * { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --cream: #FDF8F3;
    --cream-dark: #F2E9DC;
    --green: #4A7C5F;
    --green-light: #6A9E7F;
    --green-pale: #EDF5F0;
    --chalk: #F5F0E8;
    --brown: #8B6347;
    --brown-light: #C9A882;
    --rose: #E8C4B8;
    --rose-pale: #FDF0EC;
    --text: #2C2416;
    --text-muted: #8A7968;
    --white: #FFFFFF;
    --shadow: 0 2px 16px rgba(60,40,20,0.08);
    --shadow-lg: 0 8px 40px rgba(60,40,20,0.12);
    --radius: 16px;
    --radius-sm: 10px;
  }

  body {
    font-family: 'Lato', sans-serif;
    background: var(--cream);
    color: var(--text);
    min-height: 100vh;
  }

  h1, h2, h3 {
    font-family: 'Dancing Script', cursive;
    letter-spacing: 0.02em;
  }

  /* ── Auth Screen ── */
  .auth-wrap {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: linear-gradient(135deg, #EAF2EC 0%, #FAF7F2 50%, #F0EBE1 100%);
    padding: 24px;
  }

  .auth-card {
    background: var(--white);
    border-radius: 24px;
    padding: 48px 40px;
    width: 100%;
    max-width: 420px;
    box-shadow: var(--shadow-lg);
    animation: fadeUp 0.5s ease;
  }

  .auth-logo {
    text-align: center;
    margin-bottom: 32px;
  }

  .auth-logo .logo-icon {
    width: 64px;
    height: 64px;
    background: var(--green);
    border-radius: 18px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 12px;
    font-size: 28px;
  }

  .auth-logo h1 {
    font-size: 3.4rem;
    color: var(--green);
    letter-spacing: 0.02em;
    font-family: 'Dancing Script', cursive;
  }

  .auth-logo p {
    color: var(--brown-light);
    font-family: 'Cormorant Garamond', serif;
    font-style: italic;
    font-size: 1.15rem;
    margin-top: 4px;
  }

  .auth-tabs {
    display: flex;
    background: var(--cream-dark);
    border-radius: var(--radius-sm);
    padding: 4px;
    margin-bottom: 28px;
  }

  .auth-tab {
    flex: 1;
    padding: 8px;
    border: none;
    background: transparent;
    border-radius: 6px;
    font-family: 'Lato', sans-serif;
    font-size: 0.9rem;
    font-weight: 700;
    color: var(--text-muted);
    cursor: pointer;
    transition: all 0.2s;
  }

  .auth-tab.active {
    background: var(--white);
    color: var(--green);
    box-shadow: 0 1px 6px rgba(0,0,0,0.08);
  }

  .form-group {
    margin-bottom: 18px;
  }

  .form-group label {
    display: block;
    font-size: 0.82rem;
    font-weight: 700;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 6px;
  }

  .form-group input, .form-group select, .form-group textarea {
    width: 100%;
    padding: 12px 14px;
    border: 1.5px solid var(--cream-dark);
    border-radius: var(--radius-sm);
    font-family: 'Lato', sans-serif;
    font-size: 0.95rem;
    color: var(--text);
    background: var(--cream);
    transition: border-color 0.2s;
    outline: none;
  }

  .form-group input:focus, .form-group select:focus, .form-group textarea:focus {
    border-color: var(--green-light);
    background: var(--white);
  }

  .btn-primary {
    width: 100%;
    padding: 14px;
    background: var(--green);
    color: var(--white);
    border: none;
    border-radius: var(--radius-sm);
    font-family: 'Lato', sans-serif;
    font-size: 1rem;
    font-weight: 700;
    cursor: pointer;
    transition: background 0.2s, transform 0.1s;
    letter-spacing: 0.02em;
  }

  .btn-primary:hover { background: var(--green-light); }
  .btn-primary:active { transform: scale(0.99); }
  .btn-primary:disabled { background: var(--brown-light); cursor: not-allowed; }

  .btn-secondary {
    padding: 10px 20px;
    background: var(--cream-dark);
    color: var(--text);
    border: none;
    border-radius: var(--radius-sm);
    font-family: 'Lato', sans-serif;
    font-size: 0.9rem;
    font-weight: 700;
    cursor: pointer;
    transition: background 0.2s;
  }

  .btn-secondary:hover { background: var(--brown-light); color: var(--white); }

  .btn-ghost {
    padding: 10px 20px;
    background: transparent;
    color: var(--green);
    border: 1.5px solid var(--green);
    border-radius: var(--radius-sm);
    font-family: 'Lato', sans-serif;
    font-size: 0.9rem;
    font-weight: 700;
    cursor: pointer;
    transition: all 0.2s;
  }

  .btn-ghost:hover { background: var(--green-pale); }

  /* ── App Shell ── */
  .app-shell {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }

  .topbar {
    background: var(--white);
    border-bottom: 1px solid var(--cream-dark);
    padding: 0 32px;
    height: 64px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    box-shadow: 0 1px 8px rgba(60,50,30,0.06);
    position: sticky;
    top: 0;
    z-index: 100;
  }

  .topbar-logo {
    font-family: 'Dancing Script', cursive;
    font-size: 2.1rem;
    color: var(--green);
    font-weight: 700;
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .topbar-logo .dot {
    width: 10px;
    height: 10px;
    background: var(--brown-light);
    border-radius: 50%;
  }

  .topbar-right {
    display: flex;
    align-items: center;
    gap: 16px;
  }

  .user-chip {
    display: flex;
    align-items: center;
    gap: 8px;
    background: var(--cream-dark);
    border-radius: 20px;
    padding: 6px 14px 6px 8px;
    font-size: 0.85rem;
    font-weight: 700;
    color: var(--text);
  }

  .user-avatar {
    width: 28px;
    height: 28px;
    background: var(--green);
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    color: white;
    font-size: 0.75rem;
    font-weight: 700;
  }

  .main-content {
    flex: 1;
    padding: 32px;
    max-width: 1100px;
    margin: 0 auto;
    width: 100%;
  }

  /* ── Dashboard ── */
  .greeting {
    margin-bottom: 32px;
    animation: fadeUp 0.4s ease;
  }

  .greeting h2 {
    font-size: 2.6rem;
    color: var(--text);
    margin-bottom: 4px;
    font-family: 'Dancing Script', cursive;
  }

  .greeting p {
    color: var(--text-muted);
    font-family: 'Cormorant Garamond', serif;
    font-style: italic;
    font-size: 1.1rem;
  }

  .suggestion-banner {
    background: linear-gradient(135deg, var(--green) 0%, var(--green-light) 100%);
    border-radius: var(--radius);
    padding: 24px 28px;
    color: white;
    margin-bottom: 28px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    box-shadow: var(--shadow);
    animation: fadeUp 0.5s ease 0.1s both;
  }

  .suggestion-banner .suggestion-text h3 {
    font-size: 1.15rem;
    margin-bottom: 4px;
    font-family: 'Playfair Display', serif;
  }

  .suggestion-banner .suggestion-text p {
    font-size: 0.9rem;
    opacity: 0.85;
  }

  .suggestion-actions {
    display: flex;
    gap: 10px;
    flex-shrink: 0;
    margin-left: 20px;
  }

  .btn-white {
    padding: 10px 18px;
    background: white;
    color: var(--green);
    border: none;
    border-radius: var(--radius-sm);
    font-family: 'Lato', sans-serif;
    font-size: 0.85rem;
    font-weight: 700;
    cursor: pointer;
    transition: all 0.2s;
  }

  .btn-white:hover { background: var(--cream); }

  .btn-white-outline {
    padding: 10px 18px;
    background: transparent;
    color: white;
    border: 1.5px solid rgba(255,255,255,0.6);
    border-radius: var(--radius-sm);
    font-family: 'Lato', sans-serif;
    font-size: 0.85rem;
    font-weight: 700;
    cursor: pointer;
    transition: all 0.2s;
  }

  .btn-white-outline:hover { background: rgba(255,255,255,0.1); }

  .section-title {
    font-family: 'Playfair Display', serif;
    font-size: 1.2rem;
    color: var(--text);
    margin-bottom: 16px;
  }

  .kids-row {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 16px;
    margin-bottom: 32px;
    animation: fadeUp 0.5s ease 0.2s both;
  }

  .kid-card {
    background: var(--white);
    border-radius: var(--radius);
    padding: 20px;
    box-shadow: var(--shadow);
    border: 1.5px solid transparent;
    cursor: pointer;
    transition: all 0.2s;
  }

  .kid-card:hover {
    border-color: var(--green-light);
    transform: translateY(-2px);
    box-shadow: var(--shadow-lg);
  }

  .kid-avatar {
    width: 48px;
    height: 48px;
    border-radius: 14px;
    background: var(--green-pale);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 1.4rem;
    margin-bottom: 12px;
  }

  .kid-card h4 {
    font-family: 'Playfair Display', serif;
    font-size: 1.05rem;
    margin-bottom: 2px;
  }

  .kid-card .grade {
    font-size: 0.82rem;
    color: var(--text-muted);
    margin-bottom: 12px;
  }

  .subject-pills {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .subject-pill {
    background: var(--green-pale);
    color: var(--green);
    border-radius: 20px;
    padding: 3px 10px;
    font-size: 0.75rem;
    font-weight: 700;
  }

  .add-kid-card {
    background: transparent;
    border: 2px dashed var(--cream-dark);
    border-radius: var(--radius);
    padding: 20px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: all 0.2s;
    min-height: 140px;
    color: var(--text-muted);
    font-weight: 700;
    font-size: 0.9rem;
    gap: 8px;
  }

  .add-kid-card:hover {
    border-color: var(--green-light);
    color: var(--green);
    background: var(--green-pale);
  }

  .tools-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 14px;
    animation: fadeUp 0.5s ease 0.3s both;
  }

  .tool-card {
    background: var(--white);
    border-radius: var(--radius);
    padding: 20px;
    box-shadow: var(--shadow);
    cursor: pointer;
    transition: all 0.2s;
    border: 1.5px solid transparent;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .tool-card:hover {
    border-color: var(--green-light);
    transform: translateY(-2px);
  }

  .tool-icon {
    font-size: 1.6rem;
  }

  .tool-card h4 {
    font-size: 0.95rem;
    font-weight: 700;
    color: var(--text);
  }

  .tool-card p {
    font-size: 0.8rem;
    color: var(--text-muted);
    line-height: 1.4;
  }

  /* ── Modal ── */
  .modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 200;
    padding: 24px;
    animation: fadeIn 0.2s ease;
  }

  .modal {
    background: var(--white);
    border-radius: 20px;
    padding: 36px;
    width: 100%;
    max-width: 520px;
    box-shadow: var(--shadow-lg);
    animation: fadeUp 0.3s ease;
    max-height: 90vh;
    overflow-y: auto;
  }

  .modal h2 {
    font-size: 1.5rem;
    margin-bottom: 6px;
    color: var(--green);
  }

  .modal .subtitle {
    color: var(--text-muted);
    font-size: 0.9rem;
    margin-bottom: 28px;
  }

  .modal-footer {
    display: flex;
    gap: 12px;
    justify-content: flex-end;
    margin-top: 28px;
  }

  /* ── Schedule Rules ── */
  .schedule-grid {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .schedule-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 12px;
    background: var(--cream);
    border-radius: var(--radius-sm);
    flex-wrap: wrap;
  }

  .schedule-subject {
    font-weight: 700;
    color: var(--text);
    font-size: 0.9rem;
    flex: 1 1 140px;
    min-width: 140px;
  }

  .schedule-days {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }

  .day-chip {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 38px;
    padding: 5px 8px;
    border-radius: 14px;
    background: var(--white);
    border: 1.5px solid var(--cream-dark);
    color: var(--text-muted);
    font-size: 0.78rem;
    font-weight: 700;
    cursor: pointer;
    transition: all 0.15s;
    user-select: none;
  }

  .day-chip input { display: none; }

  .day-chip.active {
    background: var(--green);
    border-color: var(--green);
    color: var(--white);
  }

  .day-chip:hover { border-color: var(--green-light); }

  .rule-row {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-bottom: 8px;
  }

  .rule-row input {
    flex: 1;
    padding: 10px 12px;
    border: 1.5px solid var(--cream-dark);
    border-radius: var(--radius-sm);
    font-family: 'Lato', sans-serif;
    font-size: 0.9rem;
    background: var(--white);
  }

  .rule-row input:focus {
    outline: none;
    border-color: var(--green);
  }

  .rule-delete {
    width: 32px;
    height: 32px;
    border: none;
    background: var(--cream-dark);
    color: var(--text-muted);
    border-radius: 50%;
    font-size: 1.1rem;
    cursor: pointer;
    transition: all 0.15s;
  }

  .rule-delete:hover {
    background: #fde8e8;
    color: #c0392b;
  }

  .kid-card-hint {
    margin-top: 8px;
    font-size: 0.75rem;
    font-weight: 700;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    transition: color 0.15s;
  }

  .kid-card:hover .kid-card-hint { color: var(--green); }

  /* ── Weekly Plan Board ── */
  .week-nav {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .week-nav button {
    padding: 8px 12px;
    min-width: 36px;
    font-size: 1rem;
    line-height: 1;
  }

  .week-label {
    font-weight: 700;
    font-size: 0.9rem;
    color: var(--text);
    padding: 0 10px;
    white-space: nowrap;
  }

  .week-board {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 10px;
    margin-bottom: 8px;
  }

  .week-col {
    background: var(--cream);
    border-radius: var(--radius-sm);
    padding: 10px;
    min-height: 120px;
  }

  .week-col-header {
    text-align: center;
    margin-bottom: 8px;
    padding-bottom: 8px;
    border-bottom: 1px dashed var(--cream-dark);
  }

  .week-col-day {
    font-weight: 700;
    font-size: 0.85rem;
    color: var(--text);
  }

  .week-col-date {
    font-size: 0.72rem;
    color: var(--text-muted);
  }

  .week-col-cards {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .week-empty {
    text-align: center;
    color: var(--text-muted);
    font-size: 0.8rem;
    opacity: 0.5;
    padding: 16px 0;
  }

  .plan-card {
    background: var(--white);
    border-radius: 8px;
    padding: 8px 10px;
    box-shadow: 0 1px 3px rgba(60,40,20,0.06);
    border: 1px solid transparent;
    transition: all 0.15s;
  }

  .plan-card:hover {
    border-color: var(--green-light);
  }

  .plan-card-subject {
    font-size: 0.68rem;
    color: var(--green);
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 2px;
  }

  .plan-card-title {
    font-size: 0.82rem;
    color: var(--text);
    font-weight: 600;
    line-height: 1.3;
    margin-bottom: 6px;
  }

  .status-badge {
    display: inline-block;
    font-size: 0.62rem;
    padding: 2px 7px;
    border-radius: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .status-todo { background: var(--cream-dark); color: var(--text-muted); }
  .status-assigned { background: #FFF4D6; color: #8A6D00; }
  .status-complete { background: var(--green-pale); color: var(--green); }

  .plan-card-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    flex-wrap: wrap;
  }

  .assign-btn {
    background: transparent;
    border: 1.5px solid var(--green);
    color: var(--green);
    padding: 3px 9px;
    border-radius: 12px;
    font-size: 0.68rem;
    font-weight: 700;
    cursor: pointer;
    font-family: 'Lato', sans-serif;
    transition: all 0.15s;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    white-space: nowrap;
  }

  .assign-btn:hover {
    background: var(--green);
    color: var(--white);
  }

  @media (max-width: 760px) {
    .week-board { grid-template-columns: 1fr; }
  }

  /* ── Assignment Page (public) ── */
  .assign-wrap {
    min-height: 100vh;
    background: linear-gradient(135deg, #EAF2EC 0%, #FAF7F2 50%, #F0EBE1 100%);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
  }

  .assign-card {
    background: var(--white);
    border-radius: 24px;
    padding: 40px 32px;
    width: 100%;
    max-width: 540px;
    box-shadow: var(--shadow-lg);
    animation: fadeUp 0.4s ease;
  }

  .assign-logo {
    text-align: center;
    color: var(--green);
    font-family: 'Dancing Script', cursive;
    font-size: 1.8rem;
    margin-bottom: 24px;
    letter-spacing: 0.02em;
  }

  .assign-meta {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-bottom: 12px;
  }

  .assign-day, .assign-subject {
    background: var(--green-pale);
    color: var(--green);
    border-radius: 14px;
    padding: 4px 12px;
    font-size: 0.78rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .assign-title {
    font-family: 'Cormorant Garamond', serif;
    font-size: 2rem;
    color: var(--text);
    line-height: 1.2;
    margin-bottom: 20px;
    letter-spacing: 0.01em;
  }

  .assign-content {
    font-size: 1.05rem;
    line-height: 1.65;
    color: var(--text);
    background: var(--cream);
    border-radius: var(--radius-sm);
    padding: 20px 22px;
    margin-bottom: 28px;
    white-space: pre-wrap;
  }

  .assign-complete-btn {
    width: 100%;
    padding: 18px;
    font-size: 1.1rem;
    border-radius: var(--radius-sm);
  }

  .assign-done {
    text-align: center;
    padding: 30px 0;
  }

  .assign-done-icon {
    font-size: 3.6rem;
    margin-bottom: 12px;
  }

  .assign-done h2 {
    font-family: 'Dancing Script', cursive;
    color: var(--green);
    font-size: 2.2rem;
    margin-bottom: 8px;
  }

  .assign-done p {
    color: var(--text-muted);
    font-size: 1rem;
  }

  @media (max-width: 540px) {
    .assign-card { padding: 28px 22px; }
    .assign-title { font-size: 1.6rem; }
    .assign-content { font-size: 0.98rem; padding: 16px 18px; }
  }

  /* ── Setup Flow ── */
  .setup-wrap {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: linear-gradient(135deg, #EAF2EC 0%, #FAF7F2 100%);
    padding: 24px;
  }

  .setup-card {
    background: var(--white);
    border-radius: 24px;
    padding: 48px 40px;
    width: 100%;
    max-width: 540px;
    box-shadow: var(--shadow-lg);
    animation: fadeUp 0.4s ease;
  }

  .setup-step {
    font-size: 0.8rem;
    font-weight: 700;
    color: var(--green-light);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin-bottom: 8px;
  }

  .setup-card h2 {
    font-size: 1.8rem;
    color: var(--text);
    margin-bottom: 6px;
  }

  .setup-card .subtitle {
    color: var(--text-muted);
    margin-bottom: 32px;
    line-height: 1.5;
  }

  .learning-styles {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
    margin-bottom: 20px;
  }

  .style-option {
    border: 1.5px solid var(--cream-dark);
    border-radius: var(--radius-sm);
    padding: 14px;
    cursor: pointer;
    transition: all 0.2s;
    text-align: center;
  }

  .style-option:hover { border-color: var(--green-light); background: var(--green-pale); }
  .style-option.selected { border-color: var(--green); background: var(--green-pale); }

  .style-option .style-emoji { font-size: 1.4rem; margin-bottom: 4px; }
  .style-option .style-name { font-size: 0.85rem; font-weight: 700; color: var(--text); }
  .style-option .style-desc { font-size: 0.75rem; color: var(--text-muted); margin-top: 2px; }

  .subjects-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-bottom: 16px;
  }

  .subject-row {
    display: flex;
    gap: 10px;
    align-items: center;
  }

  .subject-row input {
    flex: 1;
    padding: 10px 12px;
    border: 1.5px solid var(--cream-dark);
    border-radius: var(--radius-sm);
    font-family: 'Lato', sans-serif;
    font-size: 0.9rem;
    background: var(--cream);
    outline: none;
  }

  .subject-row input:focus { border-color: var(--green-light); background: white; }

  .remove-btn {
    width: 32px;
    height: 32px;
    border: none;
    background: var(--cream-dark);
    border-radius: 6px;
    cursor: pointer;
    font-size: 1rem;
    color: var(--text-muted);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: all 0.2s;
  }

  .remove-btn:hover { background: #f0d0d0; color: #c0392b; }

  .add-subject-btn {
    background: none;
    border: none;
    color: var(--green);
    font-family: 'Lato', sans-serif;
    font-size: 0.9rem;
    font-weight: 700;
    cursor: pointer;
    padding: 8px 0;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .date-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }

  /* ── Generation Panel ── */
  .gen-panel {
    background: var(--white);
    border-radius: var(--radius);
    padding: 28px;
    box-shadow: var(--shadow);
    animation: fadeUp 0.4s ease;
  }

  .gen-panel h3 {
    font-size: 1.3rem;
    color: var(--green);
    margin-bottom: 20px;
  }

  .output-box {
    background: var(--cream);
    border-radius: var(--radius-sm);
    padding: 20px;
    margin-top: 20px;
    font-size: 0.9rem;
    line-height: 1.7;
    white-space: pre-wrap;
    border: 1px solid var(--cream-dark);
    min-height: 120px;
  }

  .loading-dots {
    display: flex;
    gap: 6px;
    align-items: center;
    padding: 12px 0;
  }

  .loading-dots span {
    width: 8px;
    height: 8px;
    background: var(--green-light);
    border-radius: 50%;
    animation: bounce 1.2s infinite;
  }

  .loading-dots span:nth-child(2) { animation-delay: 0.2s; }
  .loading-dots span:nth-child(3) { animation-delay: 0.4s; }

  /* ── Animations ── */
  @keyframes fadeUp {
    from { opacity: 0; transform: translateY(16px); }
    to { opacity: 1; transform: translateY(0); }
  }

  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  @keyframes bounce {
    0%, 80%, 100% { transform: translateY(0); }
    40% { transform: translateY(-8px); }
  }

  .nav-tabs {
    display: flex;
    gap: 4px;
    background: var(--cream-dark);
    border-radius: var(--radius-sm);
    padding: 4px;
    margin-bottom: 28px;
  }

  .nav-tab {
    flex: 1;
    padding: 8px 12px;
    border: none;
    background: transparent;
    border-radius: 6px;
    font-family: 'Lato', sans-serif;
    font-size: 0.85rem;
    font-weight: 700;
    color: var(--text-muted);
    cursor: pointer;
    transition: all 0.2s;
  }

  .nav-tab.active {
    background: var(--white);
    color: var(--green);
    box-shadow: 0 1px 6px rgba(0,0,0,0.08);
  }

  .empty-state {
    text-align: center;
    padding: 48px 24px;
    color: var(--text-muted);
  }

  .empty-state .empty-icon { font-size: 3rem; margin-bottom: 12px; }
  .empty-state h3 { font-size: 1.1rem; margin-bottom: 6px; color: var(--text); }
  .empty-state p { font-size: 0.9rem; line-height: 1.5; }

  /* ── Curriculum Upload ── */
  .upload-zone {
    border: 2px dashed var(--cream-dark);
    border-radius: var(--radius);
    padding: 32px 20px;
    text-align: center;
    cursor: pointer;
    transition: all 0.2s;
    background: var(--cream);
    margin-bottom: 20px;
  }

  .upload-zone:hover, .upload-zone.drag-over {
    border-color: var(--green-light);
    background: var(--green-pale);
  }

  .upload-zone .upload-icon { font-size: 2.4rem; margin-bottom: 10px; }
  .upload-zone h4 { font-size: 1rem; color: var(--text); margin-bottom: 4px; }
  .upload-zone p { font-size: 0.82rem; color: var(--text-muted); }

  .file-selected {
    display: flex;
    align-items: center;
    gap: 12px;
    background: var(--green-pale);
    border: 1.5px solid var(--green-light);
    border-radius: var(--radius-sm);
    padding: 12px 16px;
    margin-bottom: 20px;
  }

  .file-selected .file-icon { font-size: 1.4rem; }
  .file-selected .file-name { font-size: 0.9rem; font-weight: 700; color: var(--green); flex: 1; }
  .file-selected .file-size { font-size: 0.78rem; color: var(--text-muted); }

  .week-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-height: 320px;
    overflow-y: auto;
    padding-right: 4px;
  }

  .week-row {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    background: var(--cream);
    border-radius: var(--radius-sm);
    padding: 10px 14px;
    border: 1px solid var(--cream-dark);
    animation: fadeUp 0.3s ease;
  }

  .week-num {
    background: var(--green);
    color: white;
    border-radius: 6px;
    padding: 2px 8px;
    font-size: 0.75rem;
    font-weight: 700;
    flex-shrink: 0;
    margin-top: 2px;
  }

  .week-content { flex: 1; }
  .week-content .week-topic { font-size: 0.88rem; font-weight: 700; color: var(--text); }
  .week-content .week-desc { font-size: 0.8rem; color: var(--text-muted); margin-top: 2px; line-height: 1.4; }

  .parse-progress {
    background: var(--green-pale);
    border-radius: var(--radius-sm);
    padding: 16px;
    text-align: center;
    margin-bottom: 20px;
  }

  .parse-progress p { font-size: 0.88rem; color: var(--green); font-weight: 700; margin-bottom: 8px; }

  .progress-bar {
    height: 6px;
    background: var(--cream-dark);
    border-radius: 3px;
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    background: var(--green);
    border-radius: 3px;
    animation: progressAnim 2s ease-in-out infinite;
  }

  @keyframes progressAnim {
    0% { width: 20%; }
    50% { width: 80%; }
    100% { width: 20%; }
  }

  .curriculum-badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    background: var(--green-pale);
    color: var(--green);
    border-radius: 20px;
    padding: 3px 10px;
    font-size: 0.75rem;
    font-weight: 700;
    margin-left: 6px;
  }

  /* ── History Tab ── */
  .history-filters {
    display: flex;
    gap: 10px;
    margin-bottom: 20px;
    flex-wrap: wrap;
    align-items: center;
  }

  .filter-chip {
    padding: 6px 14px;
    border-radius: 20px;
    border: 1.5px solid var(--cream-dark);
    background: var(--white);
    font-family: 'Lato', sans-serif;
    font-size: 0.82rem;
    font-weight: 700;
    color: var(--text-muted);
    cursor: pointer;
    transition: all 0.2s;
  }

  .filter-chip.active {
    background: var(--green);
    border-color: var(--green);
    color: white;
  }

  .filter-chip:hover:not(.active) {
    border-color: var(--green-light);
    color: var(--green);
  }

  .history-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .history-card {
    background: var(--white);
    border-radius: var(--radius);
    padding: 18px 20px;
    box-shadow: var(--shadow);
    border: 1.5px solid transparent;
    display: flex;
    align-items: flex-start;
    gap: 16px;
    transition: all 0.2s;
    cursor: pointer;
    animation: fadeUp 0.3s ease;
  }

  .history-card:hover {
    border-color: var(--green-light);
    transform: translateX(2px);
  }

  .history-type-badge {
    width: 44px;
    height: 44px;
    border-radius: 12px;
    background: var(--green-pale);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 1.3rem;
    flex-shrink: 0;
  }

  .history-meta {
    flex: 1;
    min-width: 0;
  }

  .history-meta h4 {
    font-size: 0.95rem;
    font-weight: 700;
    color: var(--text);
    margin-bottom: 3px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .history-meta .history-sub {
    font-size: 0.8rem;
    color: var(--text-muted);
    margin-bottom: 6px;
  }

  .history-meta .history-preview {
    font-size: 0.82rem;
    color: var(--text-muted);
    line-height: 1.4;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .history-actions {
    display: flex;
    flex-direction: column;
    gap: 6px;
    flex-shrink: 0;
  }

  .icon-btn {
    width: 32px;
    height: 32px;
    border: none;
    background: var(--cream-dark);
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.9rem;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s;
    color: var(--text-muted);
  }

  .icon-btn:hover { background: var(--green-pale); color: var(--green); }
  .icon-btn.danger:hover { background: #fde8e8; color: #c0392b; }

  .history-date-divider {
    font-size: 0.78rem;
    font-weight: 700;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 8px 0 4px;
    border-bottom: 1px solid var(--cream-dark);
    margin-bottom: 8px;
  }

  .history-segmented {
    display: inline-flex;
    background: var(--cream-dark);
    border-radius: var(--radius-sm);
    padding: 4px;
    margin-bottom: 20px;
    gap: 2px;
  }

  .history-segmented button {
    padding: 8px 18px;
    border: none;
    background: transparent;
    border-radius: 6px;
    font-family: 'Lato', sans-serif;
    font-size: 0.86rem;
    font-weight: 700;
    color: var(--text-muted);
    cursor: pointer;
    transition: all 0.2s;
  }

  .history-segmented button.active {
    background: var(--white);
    color: var(--green);
    box-shadow: 0 1px 4px rgba(60,40,20,0.08);
  }

  .history-segmented button:hover:not(.active) { color: var(--text); }

  .plan-progress {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    margin-top: 6px;
    margin-bottom: 8px;
    font-size: 0.78rem;
    font-weight: 700;
  }

  .plan-count-complete { color: var(--green); }
  .plan-count-assigned { color: #8A6D00; }
  .plan-count-todo { color: var(--text-muted); }

  .plan-progress-bar {
    display: flex;
    height: 6px;
    border-radius: 3px;
    overflow: hidden;
    background: var(--cream-dark);
  }

  .plan-progress-seg {
    height: 100%;
    transition: width 0.3s;
  }

  .seg-complete { background: var(--green); }
  .seg-assigned { background: #F4C430; }
  .seg-todo { background: var(--cream-dark); }

  /* ── History Viewer Modal ── */
  .viewer-modal {
    background: var(--white);
    border-radius: 20px;
    padding: 36px;
    width: 100%;
    max-width: 680px;
    box-shadow: var(--shadow-lg);
    animation: fadeUp 0.3s ease;
    max-height: 90vh;
    display: flex;
    flex-direction: column;
  }

  .viewer-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    margin-bottom: 20px;
    gap: 16px;
  }

  .viewer-header h2 { font-size: 1.4rem; color: var(--green); }
  .viewer-header .viewer-meta { font-size: 0.82rem; color: var(--text-muted); margin-top: 4px; }

  .viewer-content {
    flex: 1;
    overflow-y: auto;
    background: var(--cream);
    border-radius: var(--radius-sm);
    padding: 20px;
    font-size: 0.9rem;
    line-height: 1.8;
    white-space: pre-wrap;
    border: 1px solid var(--cream-dark);
    margin-bottom: 20px;
  }

  .viewer-footer {
    display: flex;
    gap: 10px;
    justify-content: flex-end;
  }

  @media (max-width: 600px) {
    .main-content { padding: 16px; }
    .suggestion-banner { flex-direction: column; gap: 16px; }
    .suggestion-actions { margin-left: 0; }
    .auth-card, .setup-card { padding: 32px 24px; }
    .date-row { grid-template-columns: 1fr; }
    .learning-styles { grid-template-columns: 1fr 1fr; }
  }
`;

// ─── Constants ────────────────────────────────────────────────────────────────
const GRADE_OPTIONS = [
  "Kindergarten","1st Grade","2nd Grade","3rd Grade","4th Grade",
  "5th Grade","6th Grade","7th Grade","8th Grade","9th Grade",
  "10th Grade","11th Grade","12th Grade"
];

const LEARNING_STYLES = [
  { id: "visual", emoji: "👁️", name: "Visual", desc: "Learns through images & diagrams" },
  { id: "auditory", emoji: "👂", name: "Auditory", desc: "Learns through listening & discussion" },
  { id: "kinesthetic", emoji: "🤸", name: "Kinesthetic", desc: "Learns by doing & moving" },
  { id: "reading", emoji: "📖", name: "Reading/Writing", desc: "Learns through text & notes" },
];

const TOOLS = [
  { id: "weeklyplan", icon: "📆", title: "Weekly Plan", desc: "Auto-generate this week's Mon-Fri schedule" },
  { id: "lesson", icon: "📋", title: "Lesson Plan", desc: "Full weekly lesson plan for any subject" },
  { id: "worksheet", icon: "✏️", title: "Worksheet", desc: "Practice problems & activities" },
  { id: "quiz", icon: "🎯", title: "Quiz or Test", desc: "Assessment for any topic" },
  { id: "essay", icon: "📝", title: "Essay Feedback", desc: "Upload & get AI grading" },
  { id: "studyguide", icon: "🗂️", title: "Study Guide", desc: "Summarize & organize any topic" },
  { id: "curriculum", icon: "📅", title: "Upload Curriculum", desc: "Add a semester scope & sequence" },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getWeekNumber(startDate) {
  const start = new Date(startDate);
  const now = new Date();
  const diff = Math.floor((now - start) / (7 * 24 * 60 * 60 * 1000));
  return Math.max(1, diff + 1);
}

function getInitials(name) {
  return name.split(" ").map(n => n[0]).join("").toUpperCase().slice(0, 2);
}

// ─── Auth Screen ──────────────────────────────────────────────────────────────
function AuthScreen({ onLogin, onSignup }) {
  const [tab, setTab] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handle = async () => {
    if (!email || !password) return;
    setLoading(true);
    setError("");
    try {
      if (tab === "login") {
        await onLogin(email, password);
      } else {
        await onSignup(email, password, name || email.split("@")[0]);
      }
    } catch (e) {
      setError(e.message || "Something went wrong. Please try again.");
    }
    setLoading(false);
  };

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="auth-logo">
          <div className="logo-icon">🏫</div>
          <h1>HomeRoom</h1>
          <p>Your full-time teacher's aide, on call whenever you need her.</p>
        </div>

        <div className="auth-tabs">
          <button className={`auth-tab ${tab === "login" ? "active" : ""}`} onClick={() => setTab("login")}>Sign In</button>
          <button className={`auth-tab ${tab === "signup" ? "active" : ""}`} onClick={() => setTab("signup")}>Create Account</button>
        </div>

        {tab === "signup" && (
          <div className="form-group">
            <label>Your Name</label>
            <input placeholder="Sarah Jones" value={name} onChange={e => setName(e.target.value)} />
          </div>
        )}
        <div className="form-group">
          <label>Email</label>
          <input type="email" placeholder="mom@homeschool.com" value={email} onChange={e => setEmail(e.target.value)} />
        </div>
        <div className="form-group">
          <label>Password</label>
          <input type="password" placeholder="••••••••" value={password} onChange={e => setPassword(e.target.value)} />
        </div>
        {error && (
          <div style={{ background: "#fde8e8", color: "#c0392b", borderRadius: 8, padding: "10px 14px", fontSize: "0.85rem", marginBottom: 16 }}>
            ⚠️ {error}
          </div>
        )}
        <button className="btn-primary" onClick={handle} disabled={loading}>
          {loading ? "Just a moment..." : tab === "login" ? "Sign In to HomeRoom" : "Create My Account"}
        </button>
      </div>
    </div>
  );
}

// ─── Setup Flow ───────────────────────────────────────────────────────────────
function SetupFlow({ user, onComplete }) {
  const [step, setStep] = useState(1);
  const [kids, setKids] = useState([]);
  const [currentKid, setCurrentKid] = useState({ name: "", grade: "", learningStyle: "", subjects: ["", ""] });
  const [semesterDates, setSemesterDates] = useState({ start: "", end: "" });

  const addSubject = () => setCurrentKid(k => ({ ...k, subjects: [...k.subjects, ""] }));
  const updateSubject = (i, val) => setCurrentKid(k => ({ ...k, subjects: k.subjects.map((s, idx) => idx === i ? val : s) }));
  const removeSubject = (i) => setCurrentKid(k => ({ ...k, subjects: k.subjects.filter((_, idx) => idx !== i) }));

  const saveKid = () => {
    const filtered = { ...currentKid, subjects: currentKid.subjects.filter(s => s.trim()) };
    setKids(prev => [...prev, { ...filtered, id: Date.now(), emoji: "📚" }]);
    setCurrentKid({ name: "", grade: "", learningStyle: "", subjects: ["", ""] });
    setStep(3);
  };

  if (step === 1) return (
    <div className="setup-wrap">
      <div className="setup-card">
        <div className="setup-step">Step 1 of 3 — Welcome</div>
        <h2>Welcome to HomeRoom, {user.name}! 👋</h2>
        <p className="subtitle">Let's get your classroom set up. We'll add your kids, their subjects, and your semester dates — then HomeRoom will always know exactly where each child should be.</p>
        <button className="btn-primary" onClick={() => setStep(2)}>Let's Set Up My Classroom →</button>
      </div>
    </div>
  );

  if (step === 2) return (
    <div className="setup-wrap">
      <div className="setup-card">
        <div className="setup-step">Step 2 of 3 — Add a Student</div>
        <h2>Tell me about your student</h2>
        <p className="subtitle">You can add more kids after setup.</p>

        <div className="form-group">
          <label>Child's Name</label>
          <input placeholder="Emma" value={currentKid.name} onChange={e => setCurrentKid(k => ({ ...k, name: e.target.value }))} />
        </div>

        <div className="form-group">
          <label>Grade Level</label>
          <select value={currentKid.grade} onChange={e => setCurrentKid(k => ({ ...k, grade: e.target.value }))}>
            <option value="">Select grade...</option>
            {GRADE_OPTIONS.map(g => <option key={g} value={g}>{g}</option>)}
          </select>
        </div>

        <div className="form-group">
          <label>Learning Style</label>
          <div className="learning-styles">
            {LEARNING_STYLES.map(s => (
              <div key={s.id} className={`style-option ${currentKid.learningStyle === s.id ? "selected" : ""}`}
                onClick={() => setCurrentKid(k => ({ ...k, learningStyle: s.id }))}>
                <div className="style-emoji">{s.emoji}</div>
                <div className="style-name">{s.name}</div>
                <div className="style-desc">{s.desc}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="form-group">
          <label>Subjects This Semester</label>
          <div className="subjects-list">
            {currentKid.subjects.map((s, i) => (
              <div className="subject-row" key={i}>
                <input placeholder={`e.g. Saxon Math 7/6`} value={s} onChange={e => updateSubject(i, e.target.value)} />
                {currentKid.subjects.length > 1 && (
                  <button className="remove-btn" onClick={() => removeSubject(i)}>×</button>
                )}
              </div>
            ))}
          </div>
          <button className="add-subject-btn" onClick={addSubject}>+ Add Subject</button>
        </div>

        <button className="btn-primary" onClick={saveKid} disabled={!currentKid.name || !currentKid.grade}>
          Save Student →
        </button>
      </div>
    </div>
  );

  if (step === 3) return (
    <div className="setup-wrap">
      <div className="setup-card">
        <div className="setup-step">Step 3 of 3 — Semester Dates</div>
        <h2>When does your semester run?</h2>
        <p className="subtitle">HomeRoom uses these dates to know what week your students are on — so it can surface the right topics automatically.</p>

        <div className="date-row" style={{ marginBottom: 24 }}>
          <div className="form-group">
            <label>Semester Start</label>
            <input type="date" value={semesterDates.start} onChange={e => setSemesterDates(d => ({ ...d, start: e.target.value }))} />
          </div>
          <div className="form-group">
            <label>Semester End</label>
            <input type="date" value={semesterDates.end} onChange={e => setSemesterDates(d => ({ ...d, end: e.target.value }))} />
          </div>
        </div>

        <div style={{ background: "var(--green-pale)", borderRadius: 10, padding: "14px 16px", marginBottom: 24, fontSize: "0.88rem", color: "var(--green)", lineHeight: 1.5 }}>
          💡 <strong>Pro tip:</strong> You can also upload a curriculum scope & sequence document for each subject — HomeRoom will read it and know exactly what topic to cover each week.
        </div>

        <div style={{ display: "flex", gap: 12 }}>
          <button className="btn-secondary" onClick={() => setStep(2)}>Add Another Student</button>
          <button className="btn-primary" style={{ flex: 1 }}
            onClick={() => onComplete({ kids, semesterDates })}
            disabled={!semesterDates.start || !semesterDates.end}>
            Enter HomeRoom →
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Generation Modal ─────────────────────────────────────────────────────────
function GenerationModal({ tool, kids, onClose, onSave }) {
  const [kidId, setKidId] = useState(kids[0]?.id || "");
  const [subject, setSubject] = useState("");
  const [topic, setTopic] = useState("");
  const [loading, setLoading] = useState(false);
  const [output, setOutput] = useState("");
  const [saved, setSaved] = useState(false);

  const selectedKid = kids.find(k => String(k.id) === String(kidId));
  const subjects = selectedKid?.subjects || [];

  const generate = async () => {
    setLoading(true);
    setOutput("");
    setSaved(false);
    const kid = selectedKid;
    const prompt = buildPrompt(tool, kid, subject, topic);
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          max_tokens: 4096,
          messages: [{ role: "user", content: prompt }]
        })
      });
      const data = await res.json();
      const text = data.content?.map(b => b.text || "").join("") || "No response received.";
      setOutput(text);
      // Auto-save to history
      onSave?.({
        id: Date.now(),
        toolId: tool.id,
        toolIcon: tool.icon,
        toolTitle: tool.title,
        kidId: kidId,
        kidName: kid?.name,
        subject,
        topic,
        content: text,
        createdAt: new Date().toISOString()
      });
      setSaved(true);
    } catch (e) {
      setOutput("Something went wrong. Please try again.");
    }
    setLoading(false);
  };

  const buildPrompt = (tool, kid, subject, topic) => {
    const base = `Student: ${kid?.name}, ${kid?.grade}, learning style: ${kid?.learningStyle || "general"}. Subject: ${subject}. Topic: ${topic}.`;
    switch (tool.id) {
      case "lesson": return `${base} Create a detailed, engaging weekly lesson plan tailored to this student's learning style. Include objectives, activities, and materials needed.`;
      case "worksheet": return `${base} Create a practice worksheet with 10-15 varied problems or activities. Make it age-appropriate and engaging.`;
      case "quiz": return `${base} Create a 10-question quiz with an answer key. Mix question types (multiple choice, short answer, fill-in-the-blank).`;
      case "studyguide": return `${base} Create a comprehensive study guide that organizes the key concepts, vocabulary, and review questions for this topic.`;
      default: return `${base} Create helpful educational content for a homeschool student.`;
    }
  };

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h2>{tool.icon} {tool.title}</h2>
        <p className="subtitle">{tool.desc}</p>

        <div className="form-group">
          <label>Student</label>
          <select value={kidId} onChange={e => { setKidId(e.target.value); setSubject(""); }}>
            {kids.map(k => <option key={k.id} value={k.id}>{k.name} — {k.grade}</option>)}
          </select>
        </div>

        <div className="form-group">
          <label>Subject</label>
          <select value={subject} onChange={e => setSubject(e.target.value)}>
            <option value="">Select subject...</option>
            {subjects.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>

        <div className="form-group">
          <label>Topic or Chapter</label>
          <input placeholder="e.g. Fractions — adding unlike denominators" value={topic} onChange={e => setTopic(e.target.value)} />
        </div>

        {loading && (
          <div className="loading-dots">
            <span /><span /><span />
            <span style={{ marginLeft: 8, fontSize: "0.85rem", color: "var(--text-muted)" }}>HomeRoom is writing...</span>
          </div>
        )}

        {output && (
          <div className="output-box">{output}</div>
        )}

        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>Close</button>
          {output && (
            <button className="btn-ghost" onClick={() => window.print()}>🖨️ Print</button>
          )}
          {saved && (
            <span style={{ fontSize: "0.82rem", color: "var(--green)", fontWeight: 700, alignSelf: "center" }}>✓ Saved to history</span>
          )}
          <button className="btn-primary" style={{ width: "auto", padding: "10px 24px" }}
            onClick={generate} disabled={!subject || !topic || loading}>
            {loading ? "Generating..." : output ? "Regenerate →" : "Generate →"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Curriculum Upload Modal ──────────────────────────────────────────────────
function CurriculumUploadModal({ kids, onClose, onSave }) {
  const [kidId, setKidId] = useState(kids[0]?.id || "");
  const [subject, setSubject] = useState("");
  const [file, setFile] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [weeks, setWeeks] = useState(null);
  const [error, setError] = useState("");
  const fileInputRef = React.useRef();

  const selectedKid = kids.find(k => String(k.id) === String(kidId));
  const subjects = selectedKid?.subjects || [];

  const handleFile = (f) => {
    const allowed = ["application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/msword"];
    if (!allowed.includes(f.type) && !f.name.match(/\.(pdf|docx|doc)$/i)) {
      setError("Please upload a PDF or Word document.");
      return;
    }
    setFile(f);
    setWeeks(null);
    setError("");
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  };

  const parseCurriculum = async () => {
    if (!file || !subject) return;
    setParsing(true);
    setError("");

    try {
      // Convert file to base64
      const base64 = await new Promise((res, rej) => {
        const reader = new FileReader();
        reader.onload = () => res(reader.result.split(",")[1]);
        reader.onerror = () => rej(new Error("File read failed"));
        reader.readAsDataURL(file);
      });

      const isPdf = file.type === "application/pdf" || file.name.endsWith(".pdf");
      const mediaType = isPdf ? "application/pdf"
        : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

      const prompt = `You are analyzing a homeschool curriculum scope and sequence document for the subject "${subject}".
Extract the weekly or unit-by-unit plan from this document.

Return ONLY a JSON array with no preamble, no markdown, no backticks. Each item must have:
- week: number (1, 2, 3...)
- topic: string (short title, max 8 words)
- description: string (1-2 sentences about what is covered)

If the document uses units/chapters instead of weeks, map them to weeks sequentially.
Extract as many weeks as the document covers, up to 36.

Example format:
[{"week":1,"topic":"Introduction to Fractions","description":"Understanding numerator and denominator, identifying fractions on a number line."},{"week":2,"topic":"Equivalent Fractions","description":"Finding equivalent fractions using multiplication and division."}]`;

      const messageContent = isPdf
        ? [
            { type: "document", source: { type: "base64", media_type: mediaType, data: base64 } },
            { type: "text", text: prompt }
          ]
        : [
            // For DOCX, send as text extraction request
            { type: "document", source: { type: "base64", media_type: mediaType, data: base64 } },
            { type: "text", text: prompt }
          ];

      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          max_tokens: 4096,
          messages: [{ role: "user", content: messageContent }]
        })
      });

      const data = await res.json();
      const raw = data.content?.map(b => b.text || "").join("") || "";

      // Strip any accidental markdown fences
      const clean = raw.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(clean);

      if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("No weeks found");
      setWeeks(parsed);
    } catch (e) {
      setError("Couldn't parse the document. Make sure it's a scope & sequence or curriculum guide and try again.");
      console.error(e);
    }
    setParsing(false);
  };

  const handleSave = () => {
    onSave({ kidId: kidId, subject, weeks });
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 580 }}>
        <h2>📅 Upload Curriculum</h2>
        <p className="subtitle">Upload a scope & sequence or curriculum guide — HomeRoom will learn exactly what to cover each week.</p>

        <div className="form-group">
          <label>Student</label>
          <select value={kidId} onChange={e => { setKidId(e.target.value); setSubject(""); setWeeks(null); }}>
            {kids.map(k => <option key={k.id} value={k.id}>{k.name} — {k.grade}</option>)}
          </select>
        </div>

        <div className="form-group">
          <label>Subject</label>
          <select value={subject} onChange={e => { setSubject(e.target.value); setWeeks(null); }}>
            <option value="">Select subject...</option>
            {subjects.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>

        {!file ? (
          <div
            className={`upload-zone ${dragOver ? "drag-over" : ""}`}
            onDragOver={e => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
          >
            <div className="upload-icon">📄</div>
            <h4>Drop your curriculum document here</h4>
            <p>PDF or Word (.docx) · Scope & sequence, table of contents, or lesson guide</p>
            <input ref={fileInputRef} type="file" accept=".pdf,.docx,.doc" style={{ display: "none" }}
              onChange={e => e.target.files[0] && handleFile(e.target.files[0])} />
          </div>
        ) : (
          <div className="file-selected">
            <div className="file-icon">{file.name.endsWith(".pdf") ? "📕" : "📘"}</div>
            <div className="file-name">{file.name}</div>
            <div className="file-size">{(file.size / 1024).toFixed(0)} KB</div>
            <button className="remove-btn" onClick={() => { setFile(null); setWeeks(null); }}>×</button>
          </div>
        )}

        {error && (
          <div style={{ background: "#fde8e8", color: "#c0392b", borderRadius: 8, padding: "10px 14px", fontSize: "0.85rem", marginBottom: 16 }}>
            ⚠️ {error}
          </div>
        )}

        {parsing && (
          <div className="parse-progress">
            <p>HomeRoom is reading your curriculum...</p>
            <div className="progress-bar"><div className="progress-fill" /></div>
          </div>
        )}

        {weeks && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
              <span style={{ fontSize: "0.9rem", fontWeight: 700, color: "var(--green)" }}>
                ✓ Found {weeks.length} weeks of curriculum
              </span>
            </div>
            <div className="week-list">
              {weeks.map(w => (
                <div className="week-row" key={w.week}>
                  <div className="week-num">Wk {w.week}</div>
                  <div className="week-content">
                    <div className="week-topic">{w.topic}</div>
                    {w.description && <div className="week-desc">{w.description}</div>}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          {!weeks ? (
            <button className="btn-primary" style={{ width: "auto", padding: "10px 24px" }}
              onClick={parseCurriculum}
              disabled={!file || !subject || parsing}>
              {parsing ? "Reading..." : "Read Curriculum →"}
            </button>
          ) : (
            <button className="btn-primary" style={{ width: "auto", padding: "10px 24px" }}
              onClick={handleSave}>
              Save to {selectedKid?.name}'s Profile →
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Weekly Plan Modal ───────────────────────────────────────────────────────
const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const DAY_ABBR = ["Mon", "Tue", "Wed", "Thu", "Fri"];

function getMondayOf(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d;
}

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function fmtMonthDay(d) {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function isoLocalDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function buildWeeklyPlanPrompt(kid, subjectDays, specialRules, weekDates) {
  const subjectLines = (kid.subjects || []).map(s => {
    const days = subjectDays[s];
    const dayList = (days && days.length) ? days.join(", ") : DAY_ABBR.join(", ");
    return `- ${s}: ${dayList}`;
  }).join("\n") || "(no subjects on file)";

  const rulesText = specialRules.length
    ? specialRules.map(r => `- ${r.text}`).join("\n")
    : "(none)";

  const dateLines = weekDates.map((d, i) => `${DAY_NAMES[i]} (${fmtMonthDay(d)})`).join(", ");

  return `You are creating a weekly homeschool plan for ${kid.name}, grade ${kid.grade}, learning style: ${kid.learningStyle || "general"}.

Week (Mon-Fri): ${dateLines}

Subjects and their teaching days (Mon=Monday, Tue=Tuesday, etc.):
${subjectLines}

Special rules (must be respected — they override the subject schedule):
${rulesText}

Generate one assignment per subject per scheduled day, respecting all special rules. If a special rule says no academic work on a day, generate no items for that day.

Return ONLY a JSON array with no markdown, no preamble, no backticks. Each item must have:
- day: string (one of "Monday", "Tuesday", "Wednesday", "Thursday", "Friday")
- subject: string (matching one of the subjects above)
- task_title: string (short title, max 8 words)
- content: string (full assignment description, 2-3 sentences)

Example:
[{"day":"Monday","subject":"Math","task_title":"Adding fractions","content":"Complete pages 12-14 of the Saxon workbook. Focus on adding fractions with unlike denominators and check answers in the back."}]`;
}

function WeeklyPlanModal({ kids, onClose, onLoadScheduleRules, onLoadPlan, onSavePlan, onAssignItem, initialKidId, initialWeekStart }) {
  const [kidId, setKidId] = useState(initialKidId || kids[0]?.id || "");
  const [weekStart, setWeekStart] = useState(() =>
    initialWeekStart ? getMondayOf(new Date(initialWeekStart + "T00:00:00")) : getMondayOf(new Date())
  );
  const [items, setItems] = useState([]);
  const [generating, setGenerating] = useState(false);
  const [loadingExisting, setLoadingExisting] = useState(false);
  const [error, setError] = useState("");
  const [copiedId, setCopiedId] = useState(null);

  const selectedKid = kids.find(k => String(k.id) === String(kidId));
  const weekDates = [0, 1, 2, 3, 4].map(i => addDays(weekStart, i));
  const isoStart = isoLocalDate(weekStart);

  useEffect(() => {
    if (!kidId) return;
    let cancelled = false;
    setLoadingExisting(true);
    setError("");
    onLoadPlan({ kidId, weekStartDate: isoStart }).then(({ items: existing }) => {
      if (cancelled) return;
      setItems(existing || []);
      setLoadingExisting(false);
    }).catch(e => {
      if (cancelled) return;
      console.error(e);
      setLoadingExisting(false);
    });
    return () => { cancelled = true; };
  }, [kidId, isoStart]);

  const handleGenerate = async () => {
    if (!selectedKid) return;
    setGenerating(true);
    setError("");
    try {
      const { subjectDays, specialRules } = await onLoadScheduleRules(selectedKid.id);
      const prompt = buildWeeklyPlanPrompt(selectedKid, subjectDays, specialRules, weekDates);

      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          max_tokens: 4096,
          messages: [{ role: "user", content: prompt }]
        })
      });
      const data = await res.json();
      const raw = data.content?.map(b => b.text || "").join("") || "";
      const clean = raw.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(clean);
      if (!Array.isArray(parsed)) throw new Error("Response was not a JSON array");

      const { items: saved } = await onSavePlan({
        kidId: selectedKid.id,
        weekStartDate: isoStart,
        items: parsed
      });
      setItems(saved || []);
    } catch (e) {
      console.error(e);
      setError("Couldn't generate the plan. Please try again.");
    } finally {
      setGenerating(false);
    }
  };

  const handleAssign = async (item) => {
    if (!item.assignment_token) return;
    const url = `https://homeroom.pro/a/${item.assignment_token}`;
    try {
      if (item.status === "todo") {
        const updated = await onAssignItem(item.id);
        setItems(prev => prev.map(i => i.id === item.id
          ? { ...i, status: updated.status, assigned_at: updated.assigned_at }
          : i));
      }
      await navigator.clipboard.writeText(url);
      setCopiedId(item.id);
      setTimeout(() => setCopiedId(curr => curr === item.id ? null : curr), 2000);
    } catch (e) {
      console.error(e);
      alert("Couldn't copy link. Please try again.");
    }
  };

  const itemsByDay = DAY_NAMES.reduce((acc, d) => { acc[d] = []; return acc; }, {});
  items.forEach(it => { if (itemsByDay[it.day]) itemsByDay[it.day].push(it); });

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 1000 }}>
        <h2>📆 Weekly Plan</h2>
        <p className="subtitle">Generate a Mon-Fri schedule that respects the kid's subjects and special rules.</p>

        <div style={{ display: "flex", gap: 12, alignItems: "flex-end", marginBottom: 20, flexWrap: "wrap" }}>
          <div className="form-group" style={{ marginBottom: 0, flex: "1 1 200px", minWidth: 200 }}>
            <label>Student</label>
            <select value={kidId} onChange={e => setKidId(e.target.value)}>
              {kids.map(k => <option key={k.id} value={k.id}>{k.name} — {k.grade}</option>)}
            </select>
          </div>

          <div className="week-nav">
            <button className="btn-secondary" onClick={() => setWeekStart(addDays(weekStart, -7))} title="Previous week">‹</button>
            <div className="week-label">{fmtMonthDay(weekStart)} – {fmtMonthDay(weekDates[4])}</div>
            <button className="btn-secondary" onClick={() => setWeekStart(addDays(weekStart, 7))} title="Next week">›</button>
          </div>

          <button
            className="btn-primary"
            style={{ width: "auto", padding: "10px 20px" }}
            onClick={handleGenerate}
            disabled={generating || !kidId}
          >
            {generating ? "Generating..." : items.length ? "Regenerate" : "Generate Plan"}
          </button>
        </div>

        {error && (
          <div style={{ background: "#fde8e8", color: "#c0392b", borderRadius: 8, padding: "10px 14px", fontSize: "0.85rem", marginBottom: 16 }}>
            ⚠️ {error}
          </div>
        )}

        {loadingExisting ? (
          <p style={{ color: "var(--text-muted)" }}>Loading...</p>
        ) : (
          <div className="week-board">
            {DAY_NAMES.map((dayName, i) => (
              <div className="week-col" key={dayName}>
                <div className="week-col-header">
                  <div className="week-col-day">{DAY_ABBR[i]}</div>
                  <div className="week-col-date">{fmtMonthDay(weekDates[i])}</div>
                </div>
                <div className="week-col-cards">
                  {itemsByDay[dayName].length === 0 && <div className="week-empty">—</div>}
                  {itemsByDay[dayName].map((item, idx) => (
                    <div className="plan-card" key={item.id || `${dayName}-${idx}`}>
                      {item.subject && <div className="plan-card-subject">{item.subject}</div>}
                      <div className="plan-card-title">{item.task_title}</div>
                      <div className="plan-card-footer">
                        <span className={`status-badge status-${item.status || "todo"}`}>
                          {item.status || "todo"}
                        </span>
                        {item.assignment_token && item.status !== "complete" && (
                          <button
                            className="assign-btn"
                            onClick={() => handleAssign(item)}
                            title={item.status === "assigned" ? "Copy link" : "Assign and copy link"}
                          >
                            {copiedId === item.id
                              ? "✓ Copied!"
                              : item.status === "assigned" ? "Copy Link" : "Assign"}
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

// ─── Schedule Rules Modal ─────────────────────────────────────────────────────
const SCHEDULE_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];

function ScheduleRulesModal({ kid, onClose, onLoad, onSave }) {
  const [subjectDays, setSubjectDays] = useState(
    Object.fromEntries((kid.subjects || []).map(s => [s, [...SCHEDULE_DAYS]]))
  );
  const [specialRules, setSpecialRules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { subjectDays: loaded, specialRules: loadedRules } = await onLoad(kid.id);
      if (cancelled) return;
      setSubjectDays(
        Object.fromEntries(
          (kid.subjects || []).map(s => [s, loaded[s] ?? [...SCHEDULE_DAYS]])
        )
      );
      setSpecialRules(loadedRules);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [kid.id]);

  const toggleDay = (subject, day) => {
    setSubjectDays(prev => {
      const days = prev[subject] || [];
      const next = days.includes(day) ? days.filter(d => d !== day) : [...days, day];
      return { ...prev, [subject]: next };
    });
  };

  const updateRule = (idx, text) =>
    setSpecialRules(prev => prev.map((r, i) => i === idx ? { ...r, text } : r));
  const addRule = () => setSpecialRules(prev => [...prev, { text: "" }]);
  const deleteRule = (idx) => setSpecialRules(prev => prev.filter((_, i) => i !== idx));

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave({ kidId: kid.id, subjectDays, specialRules });
      onClose();
    } catch (e) {
      console.error(e);
      alert("Couldn't save schedule. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 580 }}>
        <h2>📅 {kid.name}'s Weekly Schedule</h2>
        <p className="subtitle">Pick which days each subject is taught and add any special rules.</p>

        {loading ? (
          <p style={{ color: "var(--text-muted)" }}>Loading...</p>
        ) : (
          <>
            <div className="form-group">
              <label>Subject Schedule</label>
              {(kid.subjects || []).length === 0 ? (
                <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>
                  No subjects yet — add some to {kid.name}'s profile first.
                </p>
              ) : (
                <div className="schedule-grid">
                  {kid.subjects.map(s => (
                    <div className="schedule-row" key={s}>
                      <div className="schedule-subject">{s}</div>
                      <div className="schedule-days">
                        {SCHEDULE_DAYS.map(d => {
                          const checked = subjectDays[s]?.includes(d);
                          return (
                            <label className={`day-chip ${checked ? "active" : ""}`} key={d}>
                              <input type="checkbox" checked={!!checked} onChange={() => toggleDay(s, d)} />
                              {d}
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="form-group">
              <label>Special Rules</label>
              {specialRules.length === 0 && (
                <p style={{ color: "var(--text-muted)", fontSize: "0.82rem", marginBottom: 8 }}>
                  e.g. "Thursdays are Mock Trial — no academic assignments"
                </p>
              )}
              {specialRules.map((r, i) => (
                <div className="rule-row" key={i}>
                  <input
                    type="text"
                    value={r.text}
                    onChange={e => updateRule(i, e.target.value)}
                    placeholder="Add a rule..."
                  />
                  <button className="rule-delete" onClick={() => deleteRule(i)} title="Delete rule">×</button>
                </div>
              ))}
              <button className="btn-secondary" style={{ marginTop: 4 }} onClick={addRule}>+ Add Rule</button>
            </div>
          </>
        )}

        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button
            className="btn-primary"
            style={{ width: "auto", padding: "10px 24px" }}
            onClick={handleSave}
            disabled={loading || saving}
          >
            {saving ? "Saving..." : "Save Schedule"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── History Viewer Modal ─────────────────────────────────────────────────────
function HistoryViewer({ item, onClose, onDelete }) {
  const handlePrint = () => {
    const win = window.open("", "_blank");
    win.document.write(`<html><head><title>${item.toolTitle} — ${item.topic}</title>
      <style>body{font-family:Georgia,serif;max-width:700px;margin:40px auto;line-height:1.8;font-size:15px;}
      h1{font-size:1.4rem;margin-bottom:4px;}p.meta{color:#888;font-size:0.85rem;margin-bottom:24px;}
      pre{white-space:pre-wrap;font-family:inherit;}</style></head><body>
      <h1>${item.toolTitle}: ${item.topic}</h1>
      <p class="meta">${item.kidName} · ${item.subject} · ${new Date(item.createdAt).toLocaleDateString()}</p>
      <pre>${item.content}</pre></body></html>`);
    win.document.close();
    win.print();
  };

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="viewer-modal">
        <div className="viewer-header">
          <div>
            <h2>{item.toolIcon} {item.toolTitle}</h2>
            <div className="viewer-meta">{item.kidName} · {item.subject} · {new Date(item.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</div>
          </div>
          <button className="remove-btn" onClick={onClose} style={{ fontSize: "1.1rem" }}>×</button>
        </div>
        <div style={{ fontWeight: 700, fontSize: "1rem", marginBottom: 12, color: "var(--text)" }}>{item.topic}</div>
        <div className="viewer-content">{item.content}</div>
        <div className="viewer-footer">
          <button className="btn-secondary danger" style={{ color: "#c0392b" }}
            onClick={() => { onDelete(item.id); onClose(); }}>🗑️ Delete</button>
          <button className="btn-ghost" onClick={handlePrint}>🖨️ Print</button>
          <button className="btn-primary" style={{ width: "auto", padding: "10px 24px" }} onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
function Dashboard({ user, kids, semesterDates, lessonPlans, onAddKid, onSaveGeneration, onDeleteGeneration, onSaveCurriculum, onLoadScheduleRules, onSaveScheduleRules, onLoadLessonPlan, onSaveLessonPlan, onAssignLessonPlanItem, onSignOut }) {
  const [activeTool, setActiveTool] = useState(null);
  const [activeTab, setActiveTab] = useState("dashboard");
  const [history, setHistory] = useState([]);
  const [viewingItem, setViewingItem] = useState(null);
  const [historyFilter, setHistoryFilter] = useState("all");
  const [historyView, setHistoryView] = useState("plans");
  const [openingPlan, setOpeningPlan] = useState(null);
  const [editingScheduleKid, setEditingScheduleKid] = useState(null);

  const handleSaveToHistory = async (entry) => {
    if (onSaveGeneration) {
      try { await onSaveGeneration(entry); } catch (e) { console.error(e); }
    }
    setHistory(prev => [entry, ...prev]);
  };

  const handleDeleteFromHistory = async (id) => {
    if (onDeleteGeneration) {
      try { await onDeleteGeneration(id); } catch (e) { console.error(e); }
    }
    setHistory(prev => prev.filter(h => h.id !== id));
  };

  const handleCurriculumSave = async ({ kidId, subject, weeks }) => {
    if (onSaveCurriculum) {
      try { await onSaveCurriculum({ kidId, subject, weeks }); } catch (e) { console.error(e); }
    }
  };

  const firstName = user.name.split(" ")[0];
  const weekNum = semesterDates.start ? getWeekNumber(semesterDates.start) : 1;
  const suggestionKid = kids[0];
  const suggestionSubject = suggestionKid?.subjects?.[0];
  const curriculumWeeks = suggestionKid?.curriculumWeeks?.[suggestionSubject];
  const currentWeekData = curriculumWeeks?.find(w => w.week === weekNum) || curriculumWeeks?.[0];
  const suggestionTopic = currentWeekData?.topic
    || suggestionKid?.currentTopics?.[suggestionSubject]
    || `Week ${weekNum} content`;

  return (
    <div className="app-shell">
      <nav className="topbar">
        <div className="topbar-logo">
          🏫 HomeRoom <div className="dot" />
        </div>
        <div className="topbar-right">
          <div className="user-chip">
            <div className="user-avatar">{getInitials(user.name)}</div>
            {user.name}
          </div>
          {onSignOut && (
            <button className="btn-secondary" style={{ fontSize: "0.8rem", padding: "6px 12px" }} onClick={onSignOut}>Sign Out</button>
          )}
        </div>
      </nav>

      <div className="main-content">
        <div className="nav-tabs">
          {["dashboard", "students", "generate", "history"].map(t => (
            <button key={t} className={`nav-tab ${activeTab === t ? "active" : ""}`}
              onClick={() => setActiveTab(t)}>
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>

        {activeTab === "dashboard" && (
          <>
            <div className="greeting">
              <h2>Good morning, {firstName}! ☀️</h2>
              <p>Week {weekNum} of your semester. Here's what's on the agenda.</p>
            </div>

            {suggestionKid && (
              <div className="suggestion-banner">
                <div className="suggestion-text">
                  <h3>📌 Heads up for {suggestionKid.name} this week</h3>
                  <p>{suggestionSubject}: {suggestionTopic} — want to generate some materials?</p>
                </div>
                <div className="suggestion-actions">
                  <button className="btn-white" onClick={() => { setActiveTool(TOOLS[1]); }}>Make Worksheet</button>
                  <button className="btn-white-outline" onClick={() => { setActiveTool(TOOLS[2]); }}>Build a Quiz</button>
                </div>
              </div>
            )}

            <p className="section-title">Your Students</p>
            <div className="kids-row">
              {kids.map(kid => (
                <div className="kid-card" key={kid.id}>
                  <div className="kid-avatar">{kid.emoji}</div>
                  <h4>{kid.name}</h4>
                  <div className="grade">{kid.grade} · {kid.learningStyle}</div>
                  <div className="subject-pills">
                    {kid.subjects.slice(0, 3).map(s => (
                      <span className="subject-pill" key={s}>
                        {s.split(" ").slice(0, 2).join(" ")}
                        {kid.curriculumWeeks?.[s] && <span style={{ marginLeft: 3 }}>✓</span>}
                      </span>
                    ))}
                    {kid.subjects.length > 3 && <span className="subject-pill">+{kid.subjects.length - 3}</span>}
                  </div>
                  {kid.curriculumWeeks && Object.keys(kid.curriculumWeeks).length > 0 && (
                    <div style={{ marginTop: 8 }}>
                      <span className="curriculum-badge">📅 {Object.keys(kid.curriculumWeeks).length} curriculum loaded</span>
                    </div>
                  )}
                </div>
              ))}
              <div className="add-kid-card" onClick={onAddKid}>
                <span style={{ fontSize: "1.5rem" }}>+</span>
                Add Student
              </div>
            </div>

            <p className="section-title">Generate Materials</p>
            <div className="tools-grid">
              {TOOLS.map(t => (
                <div className="tool-card" key={t.id} onClick={() => setActiveTool(t)}>
                  <div className="tool-icon">{t.icon}</div>
                  <h4>{t.title}</h4>
                  <p>{t.desc}</p>
                </div>
              ))}
            </div>
          </>
        )}

        {activeTab === "students" && (
          <>
            <div className="greeting"><h2>Your Students</h2></div>
            <div className="kids-row">
              {kids.map(kid => (
                <div className="kid-card" key={kid.id} onClick={() => setEditingScheduleKid(kid)} title="Edit schedule">
                  <div className="kid-avatar" style={{ fontSize: "1.8rem" }}>{kid.emoji}</div>
                  <h4>{kid.name}</h4>
                  <div className="grade">{kid.grade}</div>
                  <div className="subject-pills" style={{ marginBottom: 8 }}>
                    {kid.subjects.map(s => <span className="subject-pill" key={s}>{s}</span>)}
                  </div>
                  <div className="kid-card-hint">✏️ Edit Schedule</div>
                </div>
              ))}
              <div className="add-kid-card" onClick={onAddKid}>
                <span style={{ fontSize: "1.5rem" }}>+</span>
                Add Student
              </div>
            </div>
          </>
        )}

        {activeTab === "generate" && (
          <>
            <div className="greeting"><h2>Generate Materials</h2><p>Pick a tool to get started.</p></div>
            <div className="tools-grid">
              {TOOLS.map(t => (
                <div className="tool-card" key={t.id} onClick={() => setActiveTool(t)}>
                  <div className="tool-icon">{t.icon}</div>
                  <h4>{t.title}</h4>
                  <p>{t.desc}</p>
                </div>
              ))}
            </div>
          </>
        )}

        {activeTab === "history" && (() => {
          const TOOL_FILTERS = [
            { id: "all", label: "All" },
            { id: "lesson", label: "📋 Lesson Plans" },
            { id: "worksheet", label: "✏️ Worksheets" },
            { id: "quiz", label: "🎯 Quizzes" },
            { id: "studyguide", label: "🗂️ Study Guides" },
          ];
          const filtered = historyFilter === "all" ? history : history.filter(h => h.toolId === historyFilter);

          const grouped = filtered.reduce((acc, item) => {
            const dateKey = new Date(item.createdAt).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
            if (!acc[dateKey]) acc[dateKey] = [];
            acc[dateKey].push(item);
            return acc;
          }, {});

          const pct = (n, total) => total ? `${(n / total) * 100}%` : "0%";

          return (
            <>
              <div className="greeting"><h2>History</h2></div>

              <div className="history-segmented">
                <button
                  className={historyView === "plans" ? "active" : ""}
                  onClick={() => setHistoryView("plans")}
                >📆 Weekly Plans</button>
                <button
                  className={historyView === "materials" ? "active" : ""}
                  onClick={() => setHistoryView("materials")}
                >📋 Generated Materials</button>
              </div>

              {historyView === "plans" && (
                <>
                  {lessonPlans.length === 0 && (
                    <div className="empty-state">
                      <div className="empty-icon">📆</div>
                      <h3>No weekly plans yet</h3>
                      <p>Generate one from the Weekly Plan tool to see it here.</p>
                      <button className="btn-primary" style={{ width: "auto", marginTop: 16, padding: "10px 24px" }}
                        onClick={() => { setActiveTab("generate"); }}>Go to Generate →</button>
                    </div>
                  )}

                  <div className="history-list">
                    {lessonPlans.map(p => {
                      const monday = new Date(p.weekStartDate + "T00:00:00");
                      const friday = new Date(monday);
                      friday.setDate(monday.getDate() + 4);
                      const fmt = d => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
                      return (
                        <div className="history-card" key={p.id} onClick={() => {
                          setOpeningPlan({ kidId: p.kidId, weekStartDate: p.weekStartDate });
                          setActiveTool({ id: "weeklyplan", icon: "📆", title: "Weekly Plan" });
                        }}>
                          <div className="history-type-badge">📆</div>
                          <div className="history-meta">
                            <h4>{p.kidName} — Week of {fmt(monday)}</h4>
                            <div className="history-sub">{fmt(monday)} – {fmt(friday)}, {monday.getFullYear()}</div>
                            <div className="plan-progress">
                              <span className="plan-count plan-count-complete">{p.complete}/{p.total} complete</span>
                              <span className="plan-count plan-count-assigned">{p.assigned}/{p.total} assigned</span>
                              <span className="plan-count plan-count-todo">{p.todo}/{p.total} to do</span>
                            </div>
                            {p.total > 0 && (
                              <div className="plan-progress-bar">
                                <div className="plan-progress-seg seg-complete" style={{ width: pct(p.complete, p.total) }} />
                                <div className="plan-progress-seg seg-assigned" style={{ width: pct(p.assigned, p.total) }} />
                                <div className="plan-progress-seg seg-todo" style={{ width: pct(p.todo, p.total) }} />
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}

              {historyView === "materials" && (
                <>
                  {history.length > 0 && (
                    <div className="history-filters">
                      {TOOL_FILTERS.map(f => (
                        <button key={f.id} className={`filter-chip ${historyFilter === f.id ? "active" : ""}`}
                          onClick={() => setHistoryFilter(f.id)}>{f.label}</button>
                      ))}
                    </div>
                  )}

                  {filtered.length === 0 && (
                    <div className="empty-state">
                      <div className="empty-icon">{history.length === 0 ? "🗂️" : "🔍"}</div>
                      <h3>{history.length === 0 ? "Nothing generated yet" : "No results"}</h3>
                      <p>{history.length === 0
                        ? "Head to Generate and create your first worksheet, quiz, or lesson plan."
                        : "Try a different filter."}</p>
                      {history.length === 0 && (
                        <button className="btn-primary" style={{ width: "auto", marginTop: 16, padding: "10px 24px" }}
                          onClick={() => setActiveTab("generate")}>Generate Something →</button>
                      )}
                    </div>
                  )}

                  {Object.entries(grouped).map(([date, items]) => (
                    <div key={date}>
                      <div className="history-date-divider">{date}</div>
                      <div className="history-list">
                        {items.map(item => (
                          <div className="history-card" key={item.id} onClick={() => setViewingItem(item)}>
                            <div className="history-type-badge">{item.toolIcon}</div>
                            <div className="history-meta">
                              <h4>{item.toolTitle}: {item.topic}</h4>
                              <div className="history-sub">{item.kidName} · {item.subject}</div>
                              <div className="history-preview">{item.content}</div>
                            </div>
                            <div className="history-actions" onClick={e => e.stopPropagation()}>
                              <button className="icon-btn" title="View" onClick={() => setViewingItem(item)}>👁️</button>
                              <button className="icon-btn danger" title="Delete" onClick={() => handleDeleteFromHistory(item.id)}>🗑️</button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </>
              )}
            </>
          );
        })()}
      </div>

      {activeTool?.id === "curriculum" ? (
        <CurriculumUploadModal
          kids={kids}
          onClose={() => setActiveTool(null)}
          onSave={handleCurriculumSave}
        />
      ) : activeTool?.id === "weeklyplan" ? (
        <WeeklyPlanModal
          kids={kids}
          onClose={() => { setActiveTool(null); setOpeningPlan(null); }}
          onLoadScheduleRules={onLoadScheduleRules}
          onLoadPlan={onLoadLessonPlan}
          onSavePlan={onSaveLessonPlan}
          onAssignItem={onAssignLessonPlanItem}
          initialKidId={openingPlan?.kidId}
          initialWeekStart={openingPlan?.weekStartDate}
        />
      ) : activeTool ? (
        <GenerationModal tool={activeTool} kids={kids} onClose={() => setActiveTool(null)} onSave={handleSaveToHistory} />
      ) : null}

      {viewingItem && (
        <HistoryViewer
          item={viewingItem}
          onClose={() => setViewingItem(null)}
          onDelete={handleDeleteFromHistory}
        />
      )}

      {editingScheduleKid && (
        <ScheduleRulesModal
          kid={editingScheduleKid}
          onClose={() => setEditingScheduleKid(null)}
          onLoad={onLoadScheduleRules}
          onSave={onSaveScheduleRules}
        />
      )}
    </div>
  );
}

// ─── Assignment Page (public, no auth) ───────────────────────────────────────
function AssignmentPage({ token }) {
  const [item, setItem] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [completing, setCompleting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error: fetchError } = await supabase
        .from("lesson_plan_items")
        .select("id, day, subject, task_title, content, status, assignment_token")
        .eq("assignment_token", token)
        .maybeSingle();
      if (cancelled) return;
      if (fetchError || !data) {
        setError("This assignment link doesn't seem to work. Double-check it with your teacher.");
      } else {
        setItem(data);
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [token]);

  const markComplete = async () => {
    setCompleting(true);
    try {
      const { error: updateError } = await supabase
        .from("lesson_plan_items")
        .update({ status: "complete", completed_at: new Date().toISOString() })
        .eq("assignment_token", token);
      if (updateError) throw updateError;
      setItem(prev => ({ ...prev, status: "complete" }));
    } catch (e) {
      console.error(e);
      alert("Couldn't save. Please try again.");
    } finally {
      setCompleting(false);
    }
  };

  return (
    <div className="assign-wrap">
      <div className="assign-card">
        <div className="assign-logo">🏫 HomeRoom</div>

        {loading && <p style={{ color: "var(--text-muted)", textAlign: "center" }}>Loading...</p>}

        {error && (
          <div style={{ textAlign: "center", padding: "20px 0" }}>
            <div style={{ fontSize: "2.4rem", marginBottom: 12 }}>🤔</div>
            <p style={{ color: "var(--text-muted)" }}>{error}</p>
          </div>
        )}

        {item && item.status === "complete" && (
          <div className="assign-done">
            <div className="assign-done-icon">🎉</div>
            <h2>Great work!</h2>
            <p>Your teacher has been notified.</p>
          </div>
        )}

        {item && item.status !== "complete" && (
          <>
            <div className="assign-meta">
              {item.day && <span className="assign-day">{item.day}</span>}
              {item.subject && <span className="assign-subject">{item.subject}</span>}
            </div>
            <h1 className="assign-title">{item.task_title}</h1>
            {item.content && <div className="assign-content">{item.content}</div>}
            <button
              className="btn-primary assign-complete-btn"
              onClick={markComplete}
              disabled={completing}
            >
              {completing ? "Saving..." : "Mark Complete ✓"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ─── App Root ─────────────────────────────────────────────────────────────────
export default function HomeRoom() {
  // Public assignment route — render before any auth/data hooks fire
  const path = typeof window !== "undefined" ? window.location.pathname : "";
  const assignMatch = path.match(/^\/a\/([^/?#]+)\/?$/);
  if (assignMatch) {
    return (
      <>
        <style>{styles}</style>
        <AssignmentPage token={assignMatch[1]} />
      </>
    );
  }

  const { user, loading: authLoading, signIn, signUp, signOut } = useAuth();
  const {
    kids, semester, history, lessonPlans, dataLoading, setupDone,
    saveKid, saveSemester, saveCurriculumWeeks,
    saveGeneration, deleteGeneration,
    loadScheduleRules, saveScheduleRules,
    loadLessonPlan, saveLessonPlan, assignLessonPlanItem,
    completeSetup
  } = useHomeRoom(user?.id);

  // Loading spinner while checking auth session
  if (authLoading || (user && dataLoading)) return (
    <>
      <style>{styles}</style>
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--cream)", fontFamily: "'Caveat', cursive", fontSize: "1.4rem", color: "var(--green)" }}>
        🏫 Loading HomeRoom...
      </div>
    </>
  );

  if (!user) return (
    <>
      <style>{styles}</style>
      <AuthScreen onLogin={signIn} onSignup={signUp} />
    </>
  );

  if (!setupDone) return (
    <>
      <style>{styles}</style>
      <SetupFlow user={user} onComplete={completeSetup} />
    </>
  );

  return (
    <>
      <style>{styles}</style>
      <Dashboard
        user={user}
        kids={kids}
        semesterDates={semester}
        history={history}
        lessonPlans={lessonPlans}
        onSaveGeneration={saveGeneration}
        onDeleteGeneration={deleteGeneration}
        onSaveCurriculum={({ kidId, subject, weeks }) => saveCurriculumWeeks({ kidId, subject, weeks })}
        onLoadScheduleRules={loadScheduleRules}
        onSaveScheduleRules={saveScheduleRules}
        onLoadLessonPlan={loadLessonPlan}
        onSaveLessonPlan={saveLessonPlan}
        onAssignLessonPlanItem={assignLessonPlanItem}
        onSignOut={signOut}
        onAddKid={saveKid}
      />
    </>
  );
}