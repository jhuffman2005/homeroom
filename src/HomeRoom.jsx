import React, { useState, useEffect, useRef, useMemo } from "react";
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
      .select(`id, name, grade, learning_style, emoji, avatar_url, semester_start_date, semester_end_date, break_weeks, subjects(id, name, book_title, book_link, curriculum_weeks(week_number, topic, description))`)
      .eq("user_id", userId)
      .order("created_at");
    if (error) { console.error("loadKids:", error); return; }
    const shaped = (data || []).map(k => ({
      id: k.id, name: k.name, grade: k.grade,
      learningStyle: k.learning_style, emoji: k.emoji || "📚",
      avatarUrl: k.avatar_url || null,
      semesterStartDate: k.semester_start_date || null,
      semesterEndDate: k.semester_end_date || null,
      breakWeeks: k.break_weeks || [],
      subjects: (k.subjects || []).map(s => s.name),
      subjectDetails: (k.subjects || []).map(s => ({
        id: s.id,
        name: s.name,
        bookTitle: s.book_title || "",
        bookLink: s.book_link || "",
        weekCount: s.curriculum_weeks?.length || 0,
      })),
      curriculumWeeks: (k.subjects || []).reduce((acc, s) => {
        if (s.curriculum_weeks?.length) {
          acc[s.name] = s.curriculum_weeks
            .sort((a, b) => a.week_number - b.week_number)
            .map(w => ({ week: w.week_number, topic: w.topic, description: w.description }));
        }
        return acc;
      }, {}),
      books: (k.subjects || []).reduce((acc, s) => {
        if (s.book_title || s.book_link) {
          acc[s.name] = { title: s.book_title || "", link: s.book_link || "" };
        }
        return acc;
      }, {}),
      _subjectIds: (k.subjects || []).reduce((acc, s) => { acc[s.name] = s.id; return acc; }, {})
    }));
    setKids(shaped);
    // setupDone is gated on a saved semester (loadSemester or completeSetup) — kids alone aren't enough.
  };

  const updateKid = async ({ kidId, name, grade, learningStyle, emoji, avatarUrl, semesterStartDate, semesterEndDate, breakWeeks }) => {
    const updates = {};
    if (name !== undefined) updates.name = name;
    if (grade !== undefined) updates.grade = grade;
    if (learningStyle !== undefined) updates.learning_style = learningStyle;
    if (emoji !== undefined) updates.emoji = emoji;
    if (avatarUrl !== undefined) updates.avatar_url = avatarUrl;
    if (semesterStartDate !== undefined) updates.semester_start_date = semesterStartDate;
    if (semesterEndDate !== undefined) updates.semester_end_date = semesterEndDate;
    if (breakWeeks !== undefined) updates.break_weeks = breakWeeks;
    const { error } = await supabase.from("kids").update(updates).eq("id", kidId);
    if (error) throw error;
    await loadKids();
  };

  const addSubjectToKid = async ({ kidId, name }) => {
    const { error } = await supabase.from("subjects").insert({ kid_id: kidId, name: name.trim() });
    if (error) throw error;
    await loadKids();
  };

  const deleteSubject = async (subjectId) => {
    const { error } = await supabase.from("subjects").delete().eq("id", subjectId);
    if (error) throw error;
    await loadKids();
  };

  const updateSubjectResources = async ({ subjectId, bookTitle, bookLink }) => {
    const { error } = await supabase
      .from("subjects")
      .update({ book_title: bookTitle || null, book_link: bookLink || null })
      .eq("id", subjectId);
    if (error) throw error;
    await loadKids();
  };

  const uploadKidAvatar = async ({ kidId, file }) => {
    const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
    const path = `${userId}/${kidId}-${Date.now()}.${ext}`;
    const { error: uploadErr } = await supabase.storage
      .from("avatars")
      .upload(path, file, { upsert: true, contentType: file.type });
    if (uploadErr) throw uploadErr;
    const { data: { publicUrl } } = supabase.storage.from("avatars").getPublicUrl(path);
    await updateKid({ kidId, avatarUrl: publicUrl });
    return publicUrl;
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

  // Look up this-week / last-week semester plan entries for every subject the kid has a plan for.
  // Returns { [subject]: { topic, description, weekNumber } } for the given week_start_date.
  const loadSemesterPlanWeekFor = async ({ kidId, weekStartDate }) => {
    const { data: plans, error: plansErr } = await supabase
      .from("semester_plans")
      .select("id, subject")
      .eq("kid_id", kidId);
    if (plansErr) { console.error("loadSemesterPlanWeekFor plans:", plansErr); return {}; }
    if (!plans || !plans.length) return {};
    const subjectByPlanId = {};
    plans.forEach(p => { subjectByPlanId[p.id] = p.subject; });
    const { data: weeks, error: weeksErr } = await supabase
      .from("semester_plan_weeks")
      .select("semester_plan_id, topic, description, week_number")
      .in("semester_plan_id", plans.map(p => p.id))
      .eq("week_start_date", weekStartDate);
    if (weeksErr) { console.error("loadSemesterPlanWeekFor weeks:", weeksErr); return {}; }
    const result = {};
    (weeks || []).forEach(w => {
      const subj = subjectByPlanId[w.semester_plan_id];
      if (subj) result[subj] = { topic: w.topic, description: w.description, weekNumber: w.week_number };
    });
    return result;
  };

  const loadWeeklyCheckpoint = async ({ kidId, weekStartDate }) => {
    const { data, error } = await supabase
      .from("weekly_checkpoints").select("*")
      .eq("kid_id", kidId).eq("week_start_date", weekStartDate)
      .maybeSingle();
    if (error) { console.error("loadWeeklyCheckpoint:", error); return null; }
    return data || null;
  };

  const saveWeeklyCheckpoint = async ({ kidId, weekStartDate, carryoverNotes, approvedAt, generatedAt }) => {
    const existing = await loadWeeklyCheckpoint({ kidId, weekStartDate });
    if (existing) {
      const updates = {};
      if (carryoverNotes !== undefined) updates.carryover_notes = carryoverNotes;
      if (approvedAt !== undefined) updates.approved_at = approvedAt;
      if (generatedAt !== undefined) updates.generated_at = generatedAt;
      if (Object.keys(updates).length === 0) return existing;
      const { data, error } = await supabase
        .from("weekly_checkpoints").update(updates).eq("id", existing.id)
        .select().single();
      if (error) throw error;
      return data;
    }
    const { data, error } = await supabase
      .from("weekly_checkpoints")
      .insert({
        user_id: userId,
        kid_id: kidId,
        week_start_date: weekStartDate,
        carryover_notes: carryoverNotes ?? null,
        approved_at: approvedAt || null,
        generated_at: generatedAt || null,
      })
      .select().single();
    if (error) throw error;
    return data;
  };

  // Loads every week from every semester_plan belonging to a kid.
  // Returns groups keyed by subject:
  //   { [subject]: { planId, curriculumName, daysPerWeek, totalWeeks, weeks: [...] } }
  const loadSemesterPlanWeeksForKid = async ({ kidId }) => {
    const { data: plans, error: plansErr } = await supabase
      .from("semester_plans")
      .select("id, subject, curriculum_name, days_per_week, total_weeks")
      .eq("kid_id", kidId)
      .order("created_at");
    if (plansErr) { console.error("loadSemesterPlanWeeksForKid plans:", plansErr); return {}; }
    if (!plans || !plans.length) return {};
    const { data: weeks, error: weeksErr } = await supabase
      .from("semester_plan_weeks")
      .select("id, semester_plan_id, week_number, week_start_date, topic, description, is_break")
      .in("semester_plan_id", plans.map(p => p.id))
      .order("week_number");
    if (weeksErr) { console.error("loadSemesterPlanWeeksForKid weeks:", weeksErr); return {}; }
    const out = {};
    plans.forEach(p => {
      out[p.subject] = {
        planId: p.id,
        curriculumName: p.curriculum_name || "",
        daysPerWeek: p.days_per_week,
        totalWeeks: p.total_weeks,
        weeks: [],
      };
    });
    (weeks || []).forEach(w => {
      const subject = (plans.find(p => p.id === w.semester_plan_id) || {}).subject;
      if (!subject) return;
      out[subject].weeks.push({
        id: w.id,
        weekNumber: w.week_number,
        weekStartDate: w.week_start_date,
        topic: w.topic,
        description: w.description,
        isBreak: !!w.is_break,
      });
    });
    Object.values(out).forEach(g => g.weeks.sort((a, b) => (a.weekNumber || 0) - (b.weekNumber || 0)));
    return out;
  };

  const updateSemesterPlanWeek = async ({ id, topic, description }) => {
    const updates = {};
    if (topic !== undefined) updates.topic = topic;
    if (description !== undefined) updates.description = description;
    if (Object.keys(updates).length === 0) return null;
    const { data, error } = await supabase
      .from("semester_plan_weeks")
      .update(updates).eq("id", id)
      .select().single();
    if (error) throw error;
    return data;
  };

  const saveSemesterPlan = async ({ kidId, subject, curriculumName, daysPerWeek, totalWeeks, weeks }) => {
    const { data: planRow, error: planErr } = await supabase
      .from("semester_plans")
      .insert({
        user_id: userId,
        kid_id: kidId,
        subject,
        curriculum_name: curriculumName || null,
        days_per_week: daysPerWeek || null,
        total_weeks: totalWeeks || null,
      })
      .select()
      .single();
    if (planErr) throw planErr;

    const weekRows = (weeks || []).map(w => ({
      semester_plan_id: planRow.id,
      week_number: w.week_number,
      week_start_date: w.week_start_date || null,
      topic: w.topic || null,
      description: w.description || null,
      is_break: !!w.is_break,
    }));
    if (weekRows.length) {
      const { error: weeksErr } = await supabase.from("semester_plan_weeks").insert(weekRows);
      if (weeksErr) throw weeksErr;
    }
    return planRow.id;
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

  // Drop a generated material into a kid's weekly plan on a specific weekday.
  // Creates the plan if none exists for that week.
  const assignGenerationToPlan = async ({ kidId, date, generation }) => {
    const d = new Date(date + "T00:00:00");
    const dow = d.getDay(); // 0=Sun..6=Sat
    if (dow === 0 || dow === 6) throw new Error("Pick a weekday (Mon-Fri)");
    const dayName = DAY_NAMES[dow - 1];
    const monday = getMondayOf(d);
    const weekStartDate = isoLocalDate(monday);

    const { data: existing, error: findErr } = await supabase
      .from("lesson_plans").select("id")
      .eq("kid_id", kidId).eq("week_start_date", weekStartDate)
      .maybeSingle();
    if (findErr) throw findErr;

    let planId = existing?.id;
    if (!planId) {
      const { data: created, error: createErr } = await supabase
        .from("lesson_plans")
        .insert({ user_id: userId, kid_id: kidId, week_start_date: weekStartDate })
        .select().single();
      if (createErr) throw createErr;
      planId = created.id;
    }

    const title = generation.toolTitle && generation.topic
      ? `${generation.toolTitle}: ${generation.topic}`
      : (generation.topic || generation.toolTitle || "Assignment");

    const { data: item, error: itemErr } = await supabase
      .from("lesson_plan_items")
      .insert({
        plan_id: planId,
        day: dayName,
        subject: generation.subject || null,
        task_title: title,
        content: generation.content || null,
        status: "assigned",
        assigned_at: new Date().toISOString()
      })
      .select("id, assignment_token, status, day, task_title")
      .single();
    if (itemErr) throw itemErr;

    loadLessonPlans();
    return item;
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

  // Final setup gate: writes a semesters row (which loadSemester reads on next login
  // to mark setupDone=true) and flips the flag for the current session.
  const completeSetup = async ({ semesterDates }) => {
    if (semesterDates?.start && semesterDates?.end) {
      await saveSemester(semesterDates);
    }
    setSetupDone(true);
  };

  return {
    kids, semester, history, lessonPlans, dataLoading, setupDone,
    saveKid, saveSemester, saveCurriculumWeeks, saveSemesterPlan,
    loadSemesterPlanWeekFor, loadSemesterPlanWeeksForKid, updateSemesterPlanWeek,
    loadWeeklyCheckpoint, saveWeeklyCheckpoint,
    saveGeneration, deleteGeneration,
    loadScheduleRules, saveScheduleRules,
    loadLessonPlan, saveLessonPlan, assignLessonPlanItem,
    assignGenerationToPlan,
    updateKid, addSubjectToKid, deleteSubject, updateSubjectResources, uploadKidAvatar,
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

  /* ── Assign to Plan ── */
  .assign-to-plan {
    background: var(--green-pale);
    border-radius: var(--radius-sm);
    padding: 14px 16px;
    margin: 18px 0;
    border: 1px dashed var(--green-light);
  }

  .assign-to-plan-label {
    font-size: 0.78rem;
    font-weight: 700;
    color: var(--green);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 8px;
  }

  .assign-to-plan-row {
    display: flex;
    gap: 10px;
    align-items: center;
    flex-wrap: wrap;
  }

  .assign-to-plan-row input[type="date"] {
    padding: 9px 12px;
    border: 1.5px solid var(--cream-dark);
    border-radius: var(--radius-sm);
    font-family: 'Lato', sans-serif;
    font-size: 0.9rem;
    background: var(--white);
    color: var(--text);
    flex: 1 1 160px;
    min-width: 0;
  }

  .assign-to-plan-row input[type="date"]:focus {
    outline: none;
    border-color: var(--green);
  }

  .assign-to-plan-error {
    margin-top: 8px;
    font-size: 0.8rem;
    color: #c0392b;
    font-weight: 700;
  }

  /* ── Copyable URL field ── */
  .copyable-url {
    display: flex;
    align-items: stretch;
    gap: 0;
    background: var(--white);
    border: 1.5px solid var(--cream-dark);
    border-radius: 8px;
    overflow: hidden;
  }

  .copyable-url input {
    flex: 1;
    min-width: 0;
    border: none;
    background: transparent;
    padding: 7px 10px;
    font-family: 'Lato', sans-serif;
    font-size: 16px; /* prevent iOS zoom on focus */
    color: var(--text);
    outline: none;
  }

  .copyable-url-btn {
    border: none;
    background: var(--green-pale);
    color: var(--green);
    padding: 0 12px;
    cursor: pointer;
    font-size: 0.9rem;
    font-weight: 700;
    border-left: 1.5px solid var(--cream-dark);
    transition: background 0.15s;
  }

  .copyable-url-btn:hover {
    background: var(--green);
    color: var(--white);
  }

  .plan-card .copyable-url input { font-size: 0.72rem; padding: 5px 8px; }
  .plan-card .copyable-url-btn { padding: 0 8px; font-size: 0.78rem; }

  /* ── Student Profile Modal ── */
  .profile-section {
    border-top: 1px solid var(--cream-dark);
    padding-top: 18px;
    margin-top: 18px;
  }

  .profile-section:first-of-type {
    border-top: none;
    padding-top: 0;
    margin-top: 0;
  }

  .profile-section-title {
    font-family: 'Dancing Script', cursive;
    font-size: 1.4rem;
    color: var(--green);
    margin-bottom: 14px;
    letter-spacing: 0.02em;
  }

  .profile-avatar-row {
    display: flex;
    align-items: center;
    gap: 16px;
    margin-bottom: 16px;
  }

  .profile-avatar-display {
    width: 76px;
    height: 76px;
    border-radius: 18px;
    background: var(--green-pale);
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    flex-shrink: 0;
    border: 2px solid var(--cream-dark);
  }

  .profile-avatar-display img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .profile-avatar-actions {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .emoji-row {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }

  .emoji-btn {
    width: 36px;
    height: 36px;
    border: 1.5px solid var(--cream-dark);
    background: var(--white);
    border-radius: 10px;
    font-size: 1.1rem;
    cursor: pointer;
    transition: all 0.15s;
    padding: 0;
  }

  .emoji-btn:hover {
    border-color: var(--green-light);
    transform: scale(1.05);
  }

  .emoji-btn.active {
    background: var(--green-pale);
    border-color: var(--green);
  }

  .subject-block {
    background: var(--cream);
    border-radius: var(--radius-sm);
    padding: 12px 14px;
    margin-bottom: 10px;
  }

  .subject-block-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 10px;
  }

  .subject-block-header h4 {
    font-size: 1rem;
    font-weight: 700;
    color: var(--text);
  }

  .subject-block-fields {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }

  @media (max-width: 600px) {
    .subject-block-fields { grid-template-columns: 1fr; }
  }

  .subject-block-curr {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px dashed var(--cream-dark);
  }

  .add-subject-row {
    display: flex;
    gap: 8px;
    margin-top: 12px;
  }

  .add-subject-row input {
    flex: 1;
    padding: 10px 12px;
    border: 1.5px solid var(--cream-dark);
    border-radius: var(--radius-sm);
    font-family: 'Lato', sans-serif;
    font-size: 0.9rem;
    background: var(--white);
  }

  .add-subject-row input:focus {
    outline: none;
    border-color: var(--green);
  }

  /* ── Students sub-nav + page ── */
  .student-subnav {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-bottom: 24px;
    padding-bottom: 16px;
    border-bottom: 1px solid var(--cream-dark);
  }

  .student-pill {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 6px 14px 6px 6px;
    border-radius: 28px;
    border: 1.5px solid var(--cream-dark);
    background: var(--white);
    cursor: pointer;
    font-family: 'Lato', sans-serif;
    font-size: 0.88rem;
    font-weight: 700;
    color: var(--text);
    transition: all 0.15s;
  }

  .student-pill:hover {
    border-color: var(--green-light);
  }

  .student-pill.active {
    border-color: var(--green);
    background: var(--green-pale);
    color: var(--green);
  }

  .student-pill-avatar {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: var(--green-pale);
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    flex-shrink: 0;
    font-size: 1.1rem;
  }

  .student-pill-avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .student-pill.add {
    padding: 6px 16px;
    border-style: dashed;
    color: var(--text-muted);
  }

  .student-pill.add:hover {
    color: var(--green);
    border-color: var(--green-light);
  }

  .student-page-header {
    margin-bottom: 24px;
  }

  .student-page-header h2 {
    font-family: 'Dancing Script', cursive;
    font-size: 2.4rem;
    color: var(--green);
    letter-spacing: 0.02em;
    margin-bottom: 4px;
  }

  .student-page-sub {
    color: var(--text-muted);
    font-size: 0.95rem;
  }

  .page-section {
    background: var(--white);
    border-radius: var(--radius);
    padding: 28px;
    box-shadow: var(--shadow);
    margin-bottom: 20px;
    animation: fadeUp 0.3s ease;
  }

  .page-section-footer {
    display: flex;
    justify-content: flex-end;
    margin-top: 20px;
    padding-top: 16px;
    border-top: 1px solid var(--cream-dark);
  }

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
  { id: "lesson", icon: "📋", title: "Lesson Plan", desc: "Full weekly lesson plan for any subject" },
  { id: "worksheet", icon: "✏️", title: "Worksheet", desc: "Practice problems & activities" },
  { id: "quiz", icon: "🎯", title: "Quiz or Test", desc: "Assessment for any topic" },
  { id: "essay", icon: "📝", title: "Essay Feedback", desc: "Upload & get AI grading" },
  { id: "studyguide", icon: "🗂️", title: "Study Guide", desc: "Summarize & organize any topic" },
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
// Helpers for the semester week picker / planner
function toIsoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function parseIso(s) {
  // Treat YYYY-MM-DD as a local date (avoid UTC-shift surprises)
  return new Date(s + "T00:00:00");
}

function fmtMonDay(d) {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// Returns Mon-Fri ranges, one per week, from the Monday of startDate's week
// through the Friday on/before endDate.
function getWeeksBetween(startDate, endDate) {
  if (!startDate || !endDate) return [];
  const start = parseIso(startDate);
  const end = parseIso(endDate);
  if (isNaN(start) || isNaN(end) || end < start) return [];
  // Snap start back to its Monday
  const dow = start.getDay(); // 0=Sun,1=Mon,...6=Sat
  const daysToMonday = dow === 0 ? -6 : 1 - dow;
  start.setDate(start.getDate() + daysToMonday);
  const result = [];
  const cursor = new Date(start);
  let n = 0;
  while (cursor <= end && n < 60) {  // safety cap
    const weekStart = new Date(cursor);
    const weekEnd = new Date(cursor);
    weekEnd.setDate(weekEnd.getDate() + 4); // Friday
    result.push({ weekStart, weekEnd });
    cursor.setDate(cursor.getDate() + 7);
    n++;
  }
  return result;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const idx = result.indexOf(",");
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error("File read failed"));
    reader.readAsDataURL(file);
  });
}

function extractJsonArray(text) {
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : text;
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}

function SetupFlow({ user, onSaveKid, onUpdateKid, onSaveSemesterPlan, onComplete }) {
  const [step, setStep] = useState(1);

  // Step 2 — kid form
  const [kid, setKid] = useState({ name: "", grade: "", learningStyle: "", subjects: ["", ""] });
  const [kidId, setKidId] = useState(null);
  const [savedSubjects, setSavedSubjects] = useState([]); // filtered list of subject names that were persisted
  const [savingKid, setSavingKid] = useState(false);

  // Step 3 — semester dates + breaks
  const [semesterStart, setSemesterStart] = useState("");
  const [semesterEnd, setSemesterEnd] = useState("");
  const [breakWeekStarts, setBreakWeekStarts] = useState([]); // ISO yyyy-mm-dd of week-start dates marked as break
  const [savingDates, setSavingDates] = useState(false);

  // Step 4 — per-subject build
  const [subjectIdx, setSubjectIdx] = useState(0);
  const [curriculumName, setCurriculumName] = useState("");
  const [daysPerWeek, setDaysPerWeek] = useState(5);
  const [uploadedFile, setUploadedFile] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [generatedWeeks, setGeneratedWeeks] = useState(null);
  const [genError, setGenError] = useState("");
  const [savingPlan, setSavingPlan] = useState(false);

  // Step-2 subject editing
  const addSubject = () => setKid(k => ({ ...k, subjects: [...k.subjects, ""] }));
  const updateSubjectInput = (i, val) => setKid(k => ({ ...k, subjects: k.subjects.map((s, idx) => idx === i ? val : s) }));
  const removeSubject = (i) => setKid(k => ({ ...k, subjects: k.subjects.filter((_, idx) => idx !== i) }));

  const allWeeks = useMemo(() => getWeeksBetween(semesterStart, semesterEnd), [semesterStart, semesterEnd]);
  const schoolWeeks = useMemo(
    () => allWeeks.filter(w => !breakWeekStarts.includes(toIsoDate(w.weekStart))),
    [allWeeks, breakWeekStarts]
  );

  const currentSubject = savedSubjects[subjectIdx] || "";

  // ── Step 2: save the kid ──
  const handleSaveStudent = async () => {
    const filtered = kid.subjects.map(s => s.trim()).filter(Boolean);
    if (!kid.name || !kid.grade || filtered.length === 0) return;
    setSavingKid(true);
    try {
      const id = await onSaveKid({
        name: kid.name,
        grade: kid.grade,
        learningStyle: kid.learningStyle,
        subjects: filtered,
      });
      setKidId(id);
      setSavedSubjects(filtered);
      setStep(3);
    } catch (e) {
      console.error(e);
      alert("Couldn't save student: " + (e.message || "unknown error"));
    } finally {
      setSavingKid(false);
    }
  };

  // ── Step 3: save semester dates + breaks ──
  const toggleBreakWeek = (iso) => {
    setBreakWeekStarts(prev => prev.includes(iso) ? prev.filter(x => x !== iso) : [...prev, iso]);
  };

  const handleSaveDates = async () => {
    if (!semesterStart || !semesterEnd || allWeeks.length === 0) return;
    setSavingDates(true);
    try {
      await onUpdateKid({
        kidId,
        semesterStartDate: semesterStart,
        semesterEndDate: semesterEnd,
        breakWeeks: breakWeekStarts,
      });
      setStep(4);
    } catch (e) {
      console.error(e);
      alert("Couldn't save semester dates: " + (e.message || "unknown error"));
    } finally {
      setSavingDates(false);
    }
  };

  // ── Step 4: generate + save per-subject plan ──
  const handleGenerate = async () => {
    if (!curriculumName.trim() || schoolWeeks.length === 0) return;
    setGenerating(true);
    setGenError("");
    setGeneratedWeeks(null);
    try {
      const weeksList = schoolWeeks
        .map((w, i) => `Week ${i + 1}: ${toIsoDate(w.weekStart)} (${fmtMonDay(w.weekStart)} - ${fmtMonDay(w.weekEnd)})`)
        .join("\n");
      const firstIso = toIsoDate(schoolWeeks[0].weekStart);

      const promptText =
`You are a homeschool curriculum planner. Generate a week-by-week semester plan.

Student: ${kid.name} (Grade: ${kid.grade}${kid.learningStyle ? `, ${kid.learningStyle} learner` : ""})
Subject: ${currentSubject}
Curriculum: ${curriculumName}
Days per week: ${daysPerWeek}

The plan must cover these school weeks (in order, one entry per week — do NOT include break weeks):
${weeksList}

${uploadedFile && uploadedFile.type === "application/pdf"
  ? "A reference document (TOC / scope & sequence) is attached as a PDF — use it to determine the right topic for each week."
  : (uploadedFile ? `A reference file was named "${uploadedFile.name}" but its contents could not be read; rely on the curriculum name above.` : "")}

Return ONLY a JSON array, no markdown, no preamble. Format:
[{"week_number": 1, "week_start_date": "${firstIso}", "topic": "Short title", "description": "2-3 sentences of what to cover this week"}]

One object per school week listed above. Use the week_start_date values exactly as given.`;

      let content;
      if (uploadedFile && uploadedFile.type === "application/pdf") {
        const b64 = await fileToBase64(uploadedFile);
        content = [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } },
          { type: "text", text: promptText },
        ];
      } else {
        content = promptText;
      }

      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          max_tokens: 4096,
          messages: [{ role: "user", content }],
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "API error");
      const text = (data.content || []).map(b => b.text || "").join("");
      const parsed = extractJsonArray(text);
      if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error("Couldn't parse the plan. Try again.");
      }
      setGeneratedWeeks(parsed.map((w, i) => ({
        week_number: w.week_number ?? i + 1,
        week_start_date: w.week_start_date || (schoolWeeks[i] ? toIsoDate(schoolWeeks[i].weekStart) : null),
        topic: w.topic || "",
        description: w.description || "",
      })));
    } catch (e) {
      console.error(e);
      setGenError(e.message || "Generation failed.");
    } finally {
      setGenerating(false);
    }
  };

  const updateGeneratedWeek = (i, field, value) => {
    setGeneratedWeeks(prev => prev.map((w, idx) => idx === i ? { ...w, [field]: value } : w));
  };

  const handleLockIn = async () => {
    if (!generatedWeeks?.length) return;
    setSavingPlan(true);
    try {
      await onSaveSemesterPlan({
        kidId,
        subject: currentSubject,
        curriculumName,
        daysPerWeek,
        totalWeeks: generatedWeeks.length,
        weeks: generatedWeeks,
      });
      const nextIdx = subjectIdx + 1;
      if (nextIdx >= savedSubjects.length) {
        setStep(5);
      } else {
        setSubjectIdx(nextIdx);
        setCurriculumName("");
        setDaysPerWeek(5);
        setUploadedFile(null);
        setGeneratedWeeks(null);
        setGenError("");
      }
    } catch (e) {
      console.error(e);
      alert("Couldn't save plan: " + (e.message || "unknown error"));
    } finally {
      setSavingPlan(false);
    }
  };

  // ── Step 5: finalize ──
  const handleEnter = async () => {
    try {
      await onComplete({ semesterDates: { start: semesterStart, end: semesterEnd } });
    } catch (e) {
      console.error(e);
      alert("Couldn't finalize: " + (e.message || "unknown error"));
    }
  };

  // ── Render ──
  if (step === 1) return (
    <div className="setup-wrap">
      <div className="setup-card">
        <div className="setup-step">Step 1 of 5 — Welcome</div>
        <h2>Welcome to HomeRoom, {user.name}! 👋</h2>
        <p className="subtitle">Let's get your classroom set up. We'll add your student, plan their semester (including break weeks), and use AI to map out every subject — week by week.</p>
        <button className="btn-primary" onClick={() => setStep(2)}>Let's Set Up My Classroom →</button>
      </div>
    </div>
  );

  if (step === 2) return (
    <div className="setup-wrap">
      <div className="setup-card">
        <div className="setup-step">Step 2 of 5 — Add a Student</div>
        <h2>Tell me about your student</h2>
        <p className="subtitle">You can add more kids after setup.</p>

        <div className="form-group">
          <label>Child's Name</label>
          <input placeholder="Emma" value={kid.name} onChange={e => setKid(k => ({ ...k, name: e.target.value }))} />
        </div>

        <div className="form-group">
          <label>Grade Level</label>
          <select value={kid.grade} onChange={e => setKid(k => ({ ...k, grade: e.target.value }))}>
            <option value="">Select grade...</option>
            {GRADE_OPTIONS.map(g => <option key={g} value={g}>{g}</option>)}
          </select>
        </div>

        <div className="form-group">
          <label>Learning Style</label>
          <div className="learning-styles">
            {LEARNING_STYLES.map(s => (
              <div key={s.id} className={`style-option ${kid.learningStyle === s.id ? "selected" : ""}`}
                onClick={() => setKid(k => ({ ...k, learningStyle: s.id }))}>
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
            {kid.subjects.map((s, i) => (
              <div className="subject-row" key={i}>
                <input placeholder={`e.g. Saxon Math 7/6`} value={s} onChange={e => updateSubjectInput(i, e.target.value)} />
                {kid.subjects.length > 1 && (
                  <button className="remove-btn" onClick={() => removeSubject(i)}>×</button>
                )}
              </div>
            ))}
          </div>
          <button className="add-subject-btn" onClick={addSubject}>+ Add Subject</button>
        </div>

        <button
          className="btn-primary"
          onClick={handleSaveStudent}
          disabled={savingKid || !kid.name || !kid.grade || kid.subjects.every(s => !s.trim())}
        >
          {savingKid ? "Saving..." : "Save Student →"}
        </button>
      </div>
    </div>
  );

  if (step === 3) {
    const breakCount = breakWeekStarts.length;
    return (
      <div className="setup-wrap">
        <div className="setup-card">
          <div className="setup-step">Step 3 of 5 — Semester Dates &amp; Break Weeks</div>
          <h2>When does {kid.name || "your student"}'s semester run?</h2>
          <p className="subtitle">Pick the start and end dates, then mark any weeks off.</p>

          <div className="date-row" style={{ marginBottom: 18 }}>
            <div className="form-group">
              <label>Semester Start</label>
              <input type="date" value={semesterStart} onChange={e => setSemesterStart(e.target.value)} />
            </div>
            <div className="form-group">
              <label>Semester End</label>
              <input type="date" value={semesterEnd} onChange={e => setSemesterEnd(e.target.value)} />
            </div>
          </div>

          {allWeeks.length > 0 && (
            <div className="form-group">
              <label>Weeks ({allWeeks.length} total{breakCount ? `, ${breakCount} break` : ""})</label>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 360, overflowY: "auto", border: "1px solid var(--border, #e6e0d4)", borderRadius: 10, padding: 10 }}>
                {allWeeks.map((w, i) => {
                  const iso = toIsoDate(w.weekStart);
                  const isBreak = breakWeekStarts.includes(iso);
                  return (
                    <div key={iso} style={{
                      display: "flex", alignItems: "center", justifyContent: "space-between",
                      padding: "10px 12px", borderRadius: 8,
                      background: isBreak ? "#ececec" : "var(--green-pale, #e8f5e9)",
                      color: isBreak ? "#888" : "var(--green, #2e7d32)",
                      transition: "background 120ms ease",
                    }}>
                      <div>
                        <div style={{ fontWeight: 700, fontSize: "0.92rem" }}>
                          Week {i + 1}: {fmtMonDay(w.weekStart)} – {fmtMonDay(w.weekEnd)}
                        </div>
                        {isBreak && <div style={{ fontSize: "0.78rem", marginTop: 2 }}>No School</div>}
                      </div>
                      <div style={{ display: "flex", gap: 4, background: "rgba(255,255,255,0.6)", borderRadius: 999, padding: 3 }}>
                        <button
                          type="button"
                          onClick={() => isBreak && toggleBreakWeek(iso)}
                          style={{
                            border: 0, borderRadius: 999, padding: "5px 12px", cursor: "pointer", fontSize: "0.78rem", fontWeight: 700,
                            background: !isBreak ? "var(--green, #2e7d32)" : "transparent",
                            color: !isBreak ? "#fff" : "#666",
                          }}>School</button>
                        <button
                          type="button"
                          onClick={() => !isBreak && toggleBreakWeek(iso)}
                          style={{
                            border: 0, borderRadius: 999, padding: "5px 12px", cursor: "pointer", fontSize: "0.78rem", fontWeight: 700,
                            background: isBreak ? "#666" : "transparent",
                            color: isBreak ? "#fff" : "#666",
                          }}>Break</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div style={{ display: "flex", gap: 12, marginTop: 12 }}>
            <button className="btn-secondary" onClick={() => setStep(2)}>← Back</button>
            <button
              className="btn-primary"
              style={{ flex: 1 }}
              onClick={handleSaveDates}
              disabled={savingDates || !semesterStart || !semesterEnd || allWeeks.length === 0}
            >
              {savingDates ? "Saving..." : "Next: Build My Semester →"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (step === 4) {
    const total = savedSubjects.length;
    return (
      <div className="setup-wrap">
        <div className="setup-card">
          <div className="setup-step">Step 4 of 5 — Build My Semester ({subjectIdx + 1} of {total})</div>
          <h2>{currentSubject}</h2>
          <p className="subtitle">{schoolWeeks.length} school weeks to plan{savedSubjects.length > 1 ? `. We'll do one subject at a time.` : "."}</p>

          {generating ? (
            <div style={{ padding: "32px 16px", textAlign: "center", color: "var(--green, #2e7d32)" }}>
              <div style={{ fontSize: "1.05rem", fontWeight: 700, marginBottom: 6 }}>
                HomeRoom is building {kid.name || "your student"}'s semester...
              </div>
              <div style={{ fontSize: "0.86rem", color: "var(--text-muted, #888)" }}>This usually takes 10–30 seconds.</div>
            </div>
          ) : !generatedWeeks ? (
            <>
              <div className="form-group">
                <label>Curriculum Name</label>
                <input placeholder="e.g. Berean Builders Biology" value={curriculumName} onChange={e => setCurriculumName(e.target.value)} />
              </div>
              <div className="form-group">
                <label>Days Per Week</label>
                <select value={daysPerWeek} onChange={e => setDaysPerWeek(parseInt(e.target.value, 10))}>
                  {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n} {n === 1 ? "day" : "days"} / week</option>)}
                </select>
              </div>
              <div className="form-group">
                <label>Upload TOC / Scope &amp; Sequence (optional)</label>
                <input
                  type="file"
                  accept="application/pdf,.pdf,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  onChange={e => setUploadedFile(e.target.files?.[0] || null)}
                />
                {uploadedFile && (
                  <div style={{ fontSize: "0.78rem", color: "var(--text-muted, #888)", marginTop: 6 }}>
                    📎 {uploadedFile.name}{uploadedFile.type !== "application/pdf" && " — DOCX content can't be read directly; the curriculum name will guide the plan."}
                  </div>
                )}
              </div>
              {genError && (
                <div style={{ background: "#fde8e8", color: "#c0392b", borderRadius: 8, padding: "10px 14px", fontSize: "0.85rem", marginBottom: 16 }}>
                  ⚠️ {genError}
                </div>
              )}
              <button
                className="btn-primary"
                onClick={handleGenerate}
                disabled={!curriculumName.trim() || schoolWeeks.length === 0}
              >
                Generate Semester Plan
              </button>
            </>
          ) : (
            <>
              <div style={{ display: "flex", flexDirection: "column", gap: 10, maxHeight: 460, overflowY: "auto", marginBottom: 16, border: "1px solid var(--border, #e6e0d4)", borderRadius: 10, padding: 10 }}>
                {generatedWeeks.map((w, i) => (
                  <div key={i} style={{ background: "#fff", border: "1px solid var(--border, #e6e0d4)", borderRadius: 10, padding: 12 }}>
                    <div style={{ fontSize: "0.78rem", color: "var(--text-muted, #888)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>
                      Week {w.week_number} · {w.week_start_date}
                    </div>
                    <input
                      value={w.topic}
                      onChange={e => updateGeneratedWeek(i, "topic", e.target.value)}
                      placeholder="Topic"
                      style={{ width: "100%", fontSize: "1rem", fontWeight: 700, padding: "6px 8px", border: "1px solid transparent", borderRadius: 6, marginBottom: 6 }}
                      onFocus={e => e.target.style.border = "1px solid var(--green, #2e7d32)"}
                      onBlur={e => e.target.style.border = "1px solid transparent"}
                    />
                    <textarea
                      value={w.description}
                      onChange={e => updateGeneratedWeek(i, "description", e.target.value)}
                      placeholder="Description"
                      rows={3}
                      style={{ width: "100%", fontSize: "0.88rem", padding: "6px 8px", border: "1px solid transparent", borderRadius: 6, resize: "vertical", fontFamily: "inherit", lineHeight: 1.4 }}
                      onFocus={e => e.target.style.border = "1px solid var(--green, #2e7d32)"}
                      onBlur={e => e.target.style.border = "1px solid transparent"}
                    />
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", gap: 12 }}>
                <button className="btn-secondary" onClick={() => { setGeneratedWeeks(null); setGenError(""); }}>
                  Re-generate
                </button>
                <button
                  className="btn-primary"
                  style={{ flex: 1 }}
                  onClick={handleLockIn}
                  disabled={savingPlan}
                >
                  {savingPlan ? "Saving..."
                    : (subjectIdx + 1 < total ? "Looks Good — Next Subject →" : "Looks Good — Lock It In →")}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  if (step === 5) {
    const totalSchoolWeeks = schoolWeeks.length;
    return (
      <div className="setup-wrap">
        <div className="setup-card">
          <div className="setup-step">Step 5 of 5 — All Set!</div>
          <h2>{kid.name || "Your student"}'s semester is ready! 🎉</h2>
          <p className="subtitle">HomeRoom knows exactly what {kid.name || "they're"} learning every week.</p>

          <div style={{ background: "var(--green-pale, #e8f5e9)", borderRadius: 10, padding: "14px 18px", marginBottom: 24, color: "var(--green, #2e7d32)", lineHeight: 1.7 }}>
            <div><strong>{totalSchoolWeeks}</strong> school weeks</div>
            <div><strong>{breakWeekStarts.length}</strong> break weeks</div>
            <div><strong>{savedSubjects.length}</strong> subject{savedSubjects.length === 1 ? "" : "s"} planned: {savedSubjects.join(", ")}</div>
          </div>

          <button className="btn-primary" onClick={handleEnter}>Enter HomeRoom →</button>
        </div>
      </div>
    );
  }

  return null;
}

// ─── Generation Modal ─────────────────────────────────────────────────────────
// Mobile-Safari-friendly clipboard copy.
// Tries the modern API first; falls back to a hidden contentEditable textarea + execCommand.
async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) { /* fall through to legacy path */ }

  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.contentEditable = "true";
    ta.readOnly = false;
    ta.style.position = "fixed";
    ta.style.left = "0";
    ta.style.top = "0";
    ta.style.opacity = "0";
    ta.style.fontSize = "16px"; // prevent iOS zoom
    document.body.appendChild(ta);

    const range = document.createRange();
    range.selectNodeContents(ta);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    ta.setSelectionRange(0, text.length);

    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch (_) {
    return false;
  }
}

// Read-only URL field with a copy button. Tap-to-select for manual copy as a last resort.
function CopyableUrl({ url }) {
  const [justCopied, setJustCopied] = useState(false);
  const inputRef = useRef(null);

  const handleCopy = async () => {
    const ok = await copyToClipboard(url);
    if (ok) {
      setJustCopied(true);
      setTimeout(() => setJustCopied(false), 1500);
    }
    inputRef.current?.focus();
    inputRef.current?.select();
  };

  return (
    <div className="copyable-url">
      <input
        ref={inputRef}
        type="text"
        readOnly
        value={url}
        onFocus={e => e.target.select()}
        onClick={e => e.target.select()}
      />
      <button type="button" className="copyable-url-btn" onClick={handleCopy} title="Copy link">
        {justCopied ? "✓" : "📋"}
      </button>
    </div>
  );
}

// Default to today if it's a weekday, else snap to the upcoming Monday.
function defaultAssignDate() {
  const d = new Date();
  const dow = d.getDay();
  if (dow === 0) d.setDate(d.getDate() + 1);
  else if (dow === 6) d.setDate(d.getDate() + 2);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

// Reusable Assign-to-Plan UI used by GenerationModal and HistoryViewer.
// Reusable editor for lesson_plan_items.resource_links.
// Saves directly to Supabase; the parent only needs to provide the item id (and any
// existing links). When `itemId` is null, the editor stays in pending mode and
// shows a hint that the content has to be assigned to a student first.
function ResourceLinksEditor({ itemId, initialLinks, onSaved }) {
  const normalize = (arr) => Array.isArray(arr)
    ? arr.map(l => ({ label: l?.label || "", url: l?.url || "" }))
    : [];
  const [links, setLinks] = useState(() => normalize(initialLinks));
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [error, setError] = useState("");

  // Reset whenever we point at a different item
  useEffect(() => {
    setLinks(normalize(initialLinks));
    setSavedFlash(false);
    setError("");
  }, [itemId]); // eslint-disable-line react-hooks/exhaustive-deps

  const addLink   = () => setLinks(prev => [...prev, { label: "", url: "" }]);
  const updateAt  = (i, field, val) => setLinks(prev => prev.map((l, idx) => idx === i ? { ...l, [field]: val } : l));
  const removeAt  = (i) => setLinks(prev => prev.filter((_, idx) => idx !== i));

  const save = async () => {
    if (!itemId) { setError("Assign this to a student first to save links."); return; }
    const cleaned = links
      .map(l => ({ label: (l.label || "").trim(), url: (l.url || "").trim() }))
      .filter(l => l.label || l.url);
    setSaving(true);
    setError("");
    try {
      const { error: upErr } = await supabase
        .from("lesson_plan_items")
        .update({ resource_links: cleaned })
        .eq("id", itemId);
      if (upErr) throw upErr;
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2000);
      onSaved?.(cleaned);
    } catch (e) {
      console.error(e);
      setError(e.message || "Couldn't save.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ marginTop: 14, padding: 14, border: "1px solid var(--cream-dark, #F2E9DC)", borderRadius: 12, background: "#fff" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8, gap: 8 }}>
        <div style={{ fontSize: "0.82rem", fontWeight: 700, color: "var(--green, #4A7C5F)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
          🔗 Resource Links
        </div>
        {savedFlash && <span style={{ fontSize: "0.78rem", color: "var(--green, #4A7C5F)", fontWeight: 700 }}>✓ Saved</span>}
      </div>

      {links.length === 0 && (
        <div style={{ fontSize: "0.82rem", color: "var(--text-muted, #8A7968)", marginBottom: 10 }}>
          Add helpful videos, reference sheets, or extra practice — the student sees these on their assignment page.
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 10 }}>
        {links.map((l, i) => (
          <div key={i} style={{ display: "flex", gap: 6, alignItems: "stretch", flexWrap: "wrap" }}>
            <input
              placeholder='Label (e.g. "Watch this first")'
              value={l.label}
              onChange={e => updateAt(i, "label", e.target.value)}
              style={{ flex: "1 1 180px", minWidth: 0, padding: "8px 10px", borderRadius: 8, border: "1px solid var(--cream-dark, #F2E9DC)", fontSize: "0.88rem" }}
            />
            <input
              placeholder="https://..."
              value={l.url}
              onChange={e => updateAt(i, "url", e.target.value)}
              style={{ flex: "2 1 240px", minWidth: 0, padding: "8px 10px", borderRadius: 8, border: "1px solid var(--cream-dark, #F2E9DC)", fontSize: "0.88rem" }}
            />
            <button
              type="button"
              onClick={() => removeAt(i)}
              title="Remove"
              style={{ width: 36, padding: 0, border: 0, borderRadius: 8, background: "var(--cream-dark, #F2E9DC)", color: "#8a7968", fontSize: "1.1rem", cursor: "pointer" }}
            >×</button>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={addLink}
          style={{ border: "1px dashed var(--cream-dark, #F2E9DC)", background: "transparent", borderRadius: 8, padding: "7px 12px", fontSize: "0.85rem", cursor: "pointer", color: "var(--text-muted, #8A7968)" }}
        >+ Add Link</button>
        <button
          type="button"
          onClick={save}
          disabled={saving || !itemId}
          className="btn-primary"
          style={{ width: "auto", padding: "8px 16px", fontSize: "0.85rem", opacity: !itemId ? 0.5 : 1 }}
        >
          {saving ? "Saving..." : "Save Links"}
        </button>
      </div>

      {!itemId && (
        <div style={{ fontSize: "0.78rem", color: "var(--text-muted, #8A7968)", marginTop: 8 }}>
          Tip: assign this to a student first using the box above — then your links can be saved.
        </div>
      )}
      {error && (
        <div style={{ background: "#fde8e8", color: "#c0392b", borderRadius: 8, padding: "8px 12px", fontSize: "0.82rem", marginTop: 8 }}>⚠️ {error}</div>
      )}
    </div>
  );
}

function AssignToPlanRow({ kidId, kidName, getEntry, onAssignToPlan, onAssigned }) {
  const [date, setDate] = useState(defaultAssignDate);
  const [state, setState] = useState("idle");
  const [errMsg, setErrMsg] = useState("");
  const [lastUrl, setLastUrl] = useState("");

  const handleAssign = async () => {
    if (!kidId) { setErrMsg("Pick a student first"); setState("error"); return; }
    if (!date) { setErrMsg("Pick a date"); setState("error"); return; }
    const dow = new Date(date + "T00:00:00").getDay();
    if (dow === 0 || dow === 6) { setErrMsg("Pick a weekday (Mon-Fri)"); setState("error"); return; }

    setState("working");
    setErrMsg("");
    try {
      const item = await onAssignToPlan({ kidId, date, generation: getEntry() });
      const url = `https://homeroom.pro/a/${item.assignment_token}`;
      setLastUrl(url);
      onAssigned?.(item);
      const ok = await copyToClipboard(url);
      setState(ok ? "copied" : "ready");
      setTimeout(() => setState(curr => curr === "copied" ? "ready" : curr), 2500);
    } catch (e) {
      console.error(e);
      setErrMsg(e.message || "Couldn't assign");
      setState("error");
    }
  };

  return (
    <div className="assign-to-plan">
      <div className="assign-to-plan-label">Assign to {kidName || "student"}</div>
      <div className="assign-to-plan-row">
        <input type="date" value={date} onChange={e => setDate(e.target.value)} />
        <button
          className="btn-primary"
          style={{ width: "auto", padding: "10px 18px" }}
          onClick={handleAssign}
          disabled={state === "working"}
        >
          {state === "working" ? "Saving..."
            : state === "copied" ? "✓ Link copied!"
            : lastUrl ? "Re-copy Link"
            : "Assign & Copy Link"}
        </button>
      </div>
      {state === "error" && <div className="assign-to-plan-error">⚠️ {errMsg}</div>}
      {lastUrl && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: "0.72rem", color: "var(--text-muted)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>
            Shareable link
          </div>
          <CopyableUrl url={lastUrl} />
        </div>
      )}
    </div>
  );
}

function GenerationModal({ tool, kids, onClose, onSave, onAssignToPlan }) {
  const [kidId, setKidId] = useState(kids[0]?.id || "");
  const [subject, setSubject] = useState("");
  const [topic, setTopic] = useState("");
  const [loading, setLoading] = useState(false);
  const [output, setOutput] = useState("");
  const [saved, setSaved] = useState(false);
  const [assignedItem, setAssignedItem] = useState(null);

  const selectedKid = kids.find(k => String(k.id) === String(kidId));
  const subjects = selectedKid?.subjects || [];

  const generate = async () => {
    setLoading(true);
    setOutput("");
    setSaved(false);
    setAssignedItem(null);
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

        {output && onAssignToPlan && (
          <>
            <AssignToPlanRow
              kidId={kidId}
              kidName={selectedKid?.name}
              getEntry={() => ({
                toolTitle: tool.title,
                subject,
                topic,
                content: output,
              })}
              onAssignToPlan={onAssignToPlan}
              onAssigned={(item) => setAssignedItem(item)}
            />
            <ResourceLinksEditor
              itemId={assignedItem?.id || null}
              initialLinks={assignedItem?.resource_links || []}
            />
          </>
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
function CurriculumUploadModal({ kids, onClose, onSave, initialKidId, initialSubject }) {
  const lockKid = !!initialKidId;
  const lockSubject = !!initialSubject;
  const [kidId, setKidId] = useState(initialKidId || kids[0]?.id || "");
  const [subject, setSubject] = useState(initialSubject || "");
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

        {!lockKid && (
          <div className="form-group">
            <label>Student</label>
            <select value={kidId} onChange={e => { setKidId(e.target.value); setSubject(""); setWeeks(null); }}>
              {kids.map(k => <option key={k.id} value={k.id}>{k.name} — {k.grade}</option>)}
            </select>
          </div>
        )}

        {!lockSubject && (
          <div className="form-group">
            <label>Subject</label>
            <select value={subject} onChange={e => { setSubject(e.target.value); setWeeks(null); }}>
              <option value="">Select subject...</option>
              {subjects.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        )}

        {(lockKid || lockSubject) && (
          <div className="form-group" style={{ background: "var(--cream)", borderRadius: "var(--radius-sm)", padding: "10px 14px", marginBottom: 16 }}>
            <div style={{ fontSize: "0.78rem", color: "var(--text-muted)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>Uploading for</div>
            <div style={{ fontSize: "0.95rem", fontWeight: 700 }}>{selectedKid?.name} — {subject}</div>
          </div>
        )}

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

function buildWeeklyPlanPrompt(kid, subjectDays, specialRules, weekDates, semester) {
  // Pick the curriculum week for this calendar week, if a semester is set.
  // Use the week containing weekDates[0] (Monday).
  const weekNumber = semester?.start
    ? Math.max(1, Math.floor((weekDates[0] - new Date(semester.start + "T00:00:00")) / (7 * 86400000)) + 1)
    : null;

  const subjectLines = (kid.subjects || []).map(s => {
    const days = subjectDays[s];
    const dayList = (days && days.length) ? days.join(", ") : DAY_ABBR.join(", ");
    const book = kid.books?.[s];
    const curriculum = kid.curriculumWeeks?.[s];
    const currentWeek = (curriculum && weekNumber)
      ? curriculum.find(w => w.week === weekNumber)
      : null;

    let line = `- ${s}: scheduled ${dayList}`;
    if (book?.title) line += `\n    Book/Resource: ${book.title}${book.link ? ` (${book.link})` : ""}`;
    if (currentWeek) {
      line += `\n    This week's curriculum (Week ${currentWeek.week}): ${currentWeek.topic}`;
      if (currentWeek.description) line += ` — ${currentWeek.description}`;
    } else if (curriculum?.length) {
      line += `\n    Curriculum on file (${curriculum.length} weeks). Pick the most appropriate topic for this week.`;
    }
    return line;
  }).join("\n") || "(no subjects on file)";

  const rulesText = specialRules.length
    ? specialRules.map(r => `- ${r.text}`).join("\n")
    : "(none)";

  const dateLines = weekDates.map((d, i) => `${DAY_NAMES[i]} (${fmtMonthDay(d)})`).join(", ");

  return `You are creating a weekly homeschool plan for ${kid.name}, grade ${kid.grade}, learning style: ${kid.learningStyle || "general"}.

Week (Mon-Fri): ${dateLines}${weekNumber ? `\nCurriculum week #: ${weekNumber}` : ""}

Subjects, teaching days, books, and curriculum coverage:
${subjectLines}

Special rules (must be respected — they override the subject schedule):
${rulesText}

Ground each day's assignment in the book/curriculum coverage listed above. If a subject has a specific "This week's curriculum" topic, the assignment should cover that topic. Reference the book by name when relevant. If a special rule says no academic work on a day, generate no items for that day.

Generate one assignment per subject per scheduled day, respecting all special rules.

Return ONLY a JSON array with no markdown, no preamble, no backticks. Each item must have:
- day: string (one of "Monday", "Tuesday", "Wednesday", "Thursday", "Friday")
- subject: string (matching one of the subjects above)
- task_title: string (short title, max 8 words)
- content: string (full assignment description, 2-3 sentences, citing book pages or curriculum topic when available)

Example:
[{"day":"Monday","subject":"Math","task_title":"Adding fractions","content":"Saxon Math 7/6 — Lesson 12 (pp. 45-48). Practice adding fractions with unlike denominators and check answers in the back."}]`;
}

function WeeklyPlanModal({ kids, semester, onClose, onLoadScheduleRules, onLoadPlan, onSavePlan, onAssignItem, initialKidId, initialWeekStart, as = "modal" }) {
  const inline = as === "inline";
  const [kidId, setKidId] = useState(initialKidId || kids[0]?.id || "");
  const [weekStart, setWeekStart] = useState(() =>
    initialWeekStart ? getMondayOf(new Date(initialWeekStart + "T00:00:00")) : getMondayOf(new Date())
  );

  // When parent passes a new initialKidId (e.g. switching kids on student page), follow it
  useEffect(() => {
    if (initialKidId && initialKidId !== kidId) setKidId(initialKidId);
  }, [initialKidId]);
  useEffect(() => {
    if (initialWeekStart) {
      const d = getMondayOf(new Date(initialWeekStart + "T00:00:00"));
      if (isoLocalDate(d) !== isoLocalDate(weekStart)) setWeekStart(d);
    }
  }, [initialWeekStart]);
  const [items, setItems] = useState([]);
  const [generating, setGenerating] = useState(false);
  const [loadingExisting, setLoadingExisting] = useState(false);
  const [error, setError] = useState("");
  const [copiedId, setCopiedId] = useState(null);
  const [shownUrls, setShownUrls] = useState({}); // itemId -> url, sticky after assign so mom can re-copy

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
      const prompt = buildWeeklyPlanPrompt(selectedKid, subjectDays, specialRules, weekDates, semester);

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
      setShownUrls(prev => ({ ...prev, [item.id]: url }));
      const ok = await copyToClipboard(url);
      if (ok) {
        setCopiedId(item.id);
        setTimeout(() => setCopiedId(curr => curr === item.id ? null : curr), 2000);
      }
    } catch (e) {
      console.error(e);
      alert("Couldn't assign. Please try again.");
    }
  };

  const itemsByDay = DAY_NAMES.reduce((acc, d) => { acc[d] = []; return acc; }, {});
  items.forEach(it => { if (itemsByDay[it.day]) itemsByDay[it.day].push(it); });

  const inner = (
    <>
      {!inline && (
        <>
          <h2>📆 Weekly Plan</h2>
          <p className="subtitle">Generate a Mon-Fri schedule that respects the kid's subjects and special rules.</p>
        </>
      )}

      <div style={{ display: "flex", gap: 12, alignItems: "flex-end", marginBottom: 20, flexWrap: "wrap" }}>
        {!inline && (
          <div className="form-group" style={{ marginBottom: 0, flex: "1 1 200px", minWidth: 200 }}>
            <label>Student</label>
            <select value={kidId} onChange={e => setKidId(e.target.value)}>
              {kids.map(k => <option key={k.id} value={k.id}>{k.name} — {k.grade}</option>)}
            </select>
          </div>
        )}

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
                {itemsByDay[dayName].map((item, idx) => {
                  const url = shownUrls[item.id]
                    || (item.assignment_token && item.status !== "todo"
                        ? `https://homeroom.pro/a/${item.assignment_token}`
                        : null);
                  return (
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
                      {url && (
                        <div style={{ marginTop: 6 }}>
                          <CopyableUrl url={url} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );

  if (inline) return <div className="page-section">{inner}</div>;

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 1000 }}>
        {inner}
        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

// ─── Student Profile Modal ───────────────────────────────────────────────────
const SCHEDULE_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];
const EMOJI_OPTIONS = ["📚","✏️","🌟","🎨","🔬","🚀","🦄","🐶","🐱","🦊","🐼","🌈","⚽","🎵","🧩","🌻"];

function StudentProfileModal({
  kid, onClose,
  onUpdateKid, onAddSubject, onDeleteSubject, onUpdateSubjectResources, onUploadAvatar,
  onLoadScheduleRules, onSaveScheduleRules,
  onLaunchCurriculumUpload,
  as = "modal",
}) {
  const inline = as === "inline";
  const [name, setName] = useState(kid.name);
  const [grade, setGrade] = useState(kid.grade);
  const [learningStyle, setLearningStyle] = useState(kid.learningStyle || "");
  const [emoji, setEmoji] = useState(kid.emoji);
  const [avatarUrl, setAvatarUrl] = useState(kid.avatarUrl);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);

  const [bookEdits, setBookEdits] = useState(() => {
    const m = {};
    (kid.subjectDetails || []).forEach(s => { m[s.id] = { title: s.bookTitle, link: s.bookLink }; });
    return m;
  });
  const [newSubject, setNewSubject] = useState("");

  const [subjectDays, setSubjectDays] = useState({});
  const [specialRules, setSpecialRules] = useState([]);
  const [scheduleLoading, setScheduleLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Load schedule rules
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { subjectDays: loaded, specialRules: loadedRules } = await onLoadScheduleRules(kid.id);
      if (cancelled) return;
      setSubjectDays(Object.fromEntries(
        (kid.subjects || []).map(s => [s, loaded[s] ?? [...SCHEDULE_DAYS]])
      ));
      setSpecialRules(loadedRules);
      setScheduleLoading(false);
    })();
    return () => { cancelled = true; };
  }, [kid.id]);

  // Sync local edits when kid is reloaded after subject add/delete/curriculum upload
  const subjectsKey = (kid.subjects || []).join("|");
  useEffect(() => {
    setBookEdits(prev => {
      const next = {};
      (kid.subjectDetails || []).forEach(s => {
        next[s.id] = prev[s.id] || { title: s.bookTitle, link: s.bookLink };
      });
      return next;
    });
    setSubjectDays(prev => {
      const next = {};
      (kid.subjects || []).forEach(s => { next[s] = prev[s] ?? [...SCHEDULE_DAYS]; });
      return next;
    });
  }, [subjectsKey]);

  const handleAvatarUpload = async (file) => {
    setUploadingAvatar(true);
    try {
      const url = await onUploadAvatar({ kidId: kid.id, file });
      setAvatarUrl(url);
    } catch (e) {
      console.error(e);
      alert("Couldn't upload photo. Please try again.");
    }
    setUploadingAvatar(false);
  };

  const handleAddSubject = async () => {
    const trimmed = newSubject.trim();
    if (!trimmed) return;
    try {
      await onAddSubject({ kidId: kid.id, name: trimmed });
      setNewSubject("");
    } catch (e) { console.error(e); alert("Couldn't add subject."); }
  };

  const handleDeleteSubject = async (subjectId, subjectName) => {
    if (!window.confirm(`Delete "${subjectName}"? Curriculum and schedule for it will also be removed.`)) return;
    try { await onDeleteSubject(subjectId); }
    catch (e) { console.error(e); alert("Couldn't delete."); }
  };

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

  const handleSaveAll = async () => {
    setSaving(true);
    try {
      await onUpdateKid({ kidId: kid.id, name, grade, learningStyle, emoji, avatarUrl });
      for (const s of (kid.subjectDetails || [])) {
        const edit = bookEdits[s.id];
        if (edit && (edit.title !== s.bookTitle || edit.link !== s.bookLink)) {
          await onUpdateSubjectResources({ subjectId: s.id, bookTitle: edit.title, bookLink: edit.link });
        }
      }
      await onSaveScheduleRules({ kidId: kid.id, subjectDays, specialRules });
      if (!inline) onClose?.();
    } catch (e) {
      console.error(e);
      alert("Couldn't save profile. Please try again.");
    }
    setSaving(false);
  };

  const inner = (
    <>
      {!inline && (
        <>
          <h2>{kid.name}'s Profile</h2>
          <p className="subtitle">Basic info, subjects & curriculum, and weekly schedule — all in one place.</p>
        </>
      )}

        {/* PROFILE */}
        <div className="profile-section">
          <h3 className="profile-section-title">Profile</h3>

          <div className="profile-avatar-row">
            <div className="profile-avatar-display">
              {avatarUrl
                ? <img src={avatarUrl} alt={name} />
                : <span style={{ fontSize: "2.6rem" }}>{emoji}</span>}
            </div>
            <div className="profile-avatar-actions">
              <label className="btn-secondary" style={{ cursor: "pointer" }}>
                {uploadingAvatar ? "Uploading..." : "📷 Upload Photo"}
                <input type="file" accept="image/*" style={{ display: "none" }}
                  disabled={uploadingAvatar}
                  onChange={e => e.target.files[0] && handleAvatarUpload(e.target.files[0])} />
              </label>
              {avatarUrl && (
                <button className="btn-ghost" style={{ padding: "6px 12px", fontSize: "0.82rem" }}
                  onClick={() => setAvatarUrl(null)}>Remove photo</button>
              )}
            </div>
          </div>

          {!avatarUrl && (
            <div className="form-group">
              <label>Avatar emoji</label>
              <div className="emoji-row">
                {EMOJI_OPTIONS.map(e => (
                  <button type="button" key={e}
                    className={`emoji-btn ${emoji === e ? "active" : ""}`}
                    onClick={() => setEmoji(e)}>{e}</button>
                ))}
              </div>
            </div>
          )}

          <div className="form-group">
            <label>Name</label>
            <input value={name} onChange={e => setName(e.target.value)} />
          </div>
          <div className="form-group">
            <label>Grade</label>
            <select value={grade} onChange={e => setGrade(e.target.value)}>
              {GRADE_OPTIONS.map(g => <option key={g} value={g}>{g}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label>Learning Style</label>
            <select value={learningStyle} onChange={e => setLearningStyle(e.target.value)}>
              <option value="">Pick one...</option>
              {LEARNING_STYLES.map(s => <option key={s.id} value={s.id}>{s.emoji} {s.name}</option>)}
            </select>
          </div>
        </div>

        {/* SUBJECTS & CURRICULUM */}
        <div className="profile-section">
          <h3 className="profile-section-title">Subjects & Curriculum</h3>
          {(kid.subjectDetails || []).length === 0 && (
            <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>No subjects yet. Add one below.</p>
          )}
          {(kid.subjectDetails || []).map(s => {
            const edit = bookEdits[s.id] || { title: "", link: "" };
            return (
              <div className="subject-block" key={s.id}>
                <div className="subject-block-header">
                  <h4>{s.name}</h4>
                  <button className="rule-delete" onClick={() => handleDeleteSubject(s.id, s.name)} title="Delete subject">×</button>
                </div>
                <div className="subject-block-fields">
                  <div className="form-group" style={{ marginBottom: 8 }}>
                    <label style={{ fontSize: "0.72rem" }}>Book / Resource Title</label>
                    <input placeholder="e.g. Saxon Math 7/6"
                      value={edit.title}
                      onChange={e => setBookEdits(prev => ({ ...prev, [s.id]: { ...edit, title: e.target.value } }))} />
                  </div>
                  <div className="form-group" style={{ marginBottom: 8 }}>
                    <label style={{ fontSize: "0.72rem" }}>Link</label>
                    <input placeholder="https://..."
                      value={edit.link}
                      onChange={e => setBookEdits(prev => ({ ...prev, [s.id]: { ...edit, link: e.target.value } }))} />
                  </div>
                </div>
                <div className="subject-block-curr">
                  <span style={{ fontSize: "0.82rem", color: s.weekCount > 0 ? "var(--green)" : "var(--text-muted)", fontWeight: 700 }}>
                    {s.weekCount > 0 ? `📅 ${s.weekCount} weeks of curriculum loaded` : "No curriculum yet"}
                  </span>
                  <button className="btn-ghost" style={{ padding: "6px 12px", fontSize: "0.78rem" }}
                    onClick={() => onLaunchCurriculumUpload({ kidId: kid.id, subject: s.name })}>
                    {s.weekCount > 0 ? "Replace" : "Upload"}
                  </button>
                </div>
              </div>
            );
          })}
          <div className="add-subject-row">
            <input placeholder="Add a subject..." value={newSubject}
              onChange={e => setNewSubject(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleAddSubject()} />
            <button className="btn-secondary" onClick={handleAddSubject}>+ Add</button>
          </div>
        </div>

        {/* SCHEDULE */}
        <div className="profile-section">
          <h3 className="profile-section-title">Weekly Schedule</h3>
          {scheduleLoading ? (
            <p style={{ color: "var(--text-muted)" }}>Loading...</p>
          ) : (
            <>
              {(kid.subjects || []).length === 0 ? (
                <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>Add subjects above to set their schedule.</p>
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
              <div style={{ marginTop: 16 }}>
                <label style={{ fontSize: "0.85rem", fontWeight: 700, color: "var(--text)", marginBottom: 6, display: "block" }}>Special Rules</label>
                {specialRules.length === 0 && (
                  <p style={{ color: "var(--text-muted)", fontSize: "0.78rem", marginBottom: 6 }}>
                    e.g. "Thursdays are Mock Trial — no academic assignments"
                  </p>
                )}
                {specialRules.map((r, i) => (
                  <div className="rule-row" key={i}>
                    <input type="text" value={r.text} onChange={e => updateRule(i, e.target.value)} placeholder="Add a rule..." />
                    <button className="rule-delete" onClick={() => deleteRule(i)} title="Delete rule">×</button>
                  </div>
                ))}
                <button className="btn-secondary" style={{ marginTop: 4 }} onClick={addRule}>+ Add Rule</button>
              </div>
            </>
          )}
        </div>

      <div className={inline ? "page-section-footer" : "modal-footer"}>
        {!inline && <button className="btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>}
        <button className="btn-primary" style={{ width: "auto", padding: "10px 24px" }}
          onClick={async () => { await handleSaveAll(); }} disabled={saving}>
          {saving ? "Saving..." : "Save Profile"}
        </button>
      </div>
    </>
  );

  if (inline) return <div className="page-section">{inner}</div>;

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 680 }}>
        {inner}
      </div>
    </div>
  );
}

// ─── History Viewer Modal ─────────────────────────────────────────────────────
function HistoryViewer({ item, onClose, onDelete, onAssignToPlan }) {
  const [assignedItem, setAssignedItem] = useState(null);

  // Look up any existing lesson_plan_item that came from this generation so the
  // ResourceLinksEditor can display previously-saved links.
  useEffect(() => {
    if (!item?.kidId) { setAssignedItem(null); return; }
    let cancelled = false;
    (async () => {
      const taskTitle = `${item.toolTitle}: ${item.topic}`;
      const { data: plans } = await supabase
        .from("lesson_plans").select("id").eq("kid_id", item.kidId);
      if (cancelled) return;
      if (!plans || plans.length === 0) { setAssignedItem(null); return; }
      const { data: rows } = await supabase
        .from("lesson_plan_items")
        .select("id, resource_links, assignment_token")
        .in("plan_id", plans.map(p => p.id))
        .eq("subject", item.subject || "")
        .eq("task_title", taskTitle)
        .order("created_at", { ascending: false })
        .limit(1);
      if (cancelled) return;
      if (rows && rows[0]) setAssignedItem(rows[0]);
      else setAssignedItem(null);
    })();
    return () => { cancelled = true; };
  }, [item?.id, item?.kidId, item?.toolTitle, item?.topic, item?.subject]);

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
        {onAssignToPlan && item.kidId && (
          <>
            <AssignToPlanRow
              kidId={item.kidId}
              kidName={item.kidName}
              getEntry={() => ({
                toolTitle: item.toolTitle,
                subject: item.subject,
                topic: item.topic,
                content: item.content,
              })}
              onAssignToPlan={onAssignToPlan}
              onAssigned={(it) => setAssignedItem(it)}
            />
            <ResourceLinksEditor
              itemId={assignedItem?.id || null}
              initialLinks={assignedItem?.resource_links || []}
            />
          </>
        )}
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
// ─── Sunday Planning Flow ────────────────────────────────────────────────────
// Normalize a "Mon" / "Monday" / "Tue" / etc. into the full DAY_NAMES form.
function normalizeDay(d) {
  if (!d) return null;
  const lower = String(d).toLowerCase().slice(0, 3);
  const map = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday" };
  return map[lower] || null;
}

function orderedScheduleDays(days) {
  const set = new Set((days || []).map(normalizeDay).filter(Boolean));
  return DAY_NAMES.filter(d => set.has(d));
}

function buildSundayPrompt(tool, kid, subject, topic, description, carryover) {
  const base = `Student: ${kid?.name}, ${kid?.grade}, learning style: ${kid?.learningStyle || "general"}.\nSubject: ${subject}.\nTopic this week: ${topic}.${description ? `\nWhat to cover: ${description}` : ""}${carryover ? `\nCarryover from last week: ${carryover}` : ""}`;
  switch (tool.id) {
    case "lesson":    return `${base}\n\nCreate a detailed, engaging weekly lesson plan tailored to this student's learning style. Include clear daily objectives, activities, and any materials needed. Keep it focused on this week's topic.`;
    case "worksheet": return `${base}\n\nCreate a practice worksheet with 10-15 varied problems or activities for this week's topic. Make it age-appropriate and engaging.`;
    case "quiz":      return `${base}\n\nCreate a 10-question quiz covering this week's topic, with an answer key. Mix question types (multiple choice, short answer, fill-in-the-blank).`;
    default:          return `${base}\n\nCreate helpful homeschool material for this week.`;
  }
}

function SundayPlanningFlow({
  kid,
  weekStartDate,
  onLoadScheduleRules,
  onLoadSemesterPlanWeekFor,
  onLoadWeeklyCheckpoint,
  onSaveWeeklyCheckpoint,
  onSaveLessonPlan,
  onClose,
}) {
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  // Step 1
  const [lastWeekTopics, setLastWeekTopics] = useState({});
  const [completionStatus, setCompletionStatus] = useState({}); // {subject: 'yes'|'partial'|'no'}
  const [carryoverText, setCarryoverText] = useState({});      // {subject: ""}

  // Step 2
  const [thisWeekTopics, setThisWeekTopics] = useState({}); // editable: {subject: {topic, description}}
  const [subjectDays, setSubjectDays] = useState({});

  // Step 3
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState({}); // {subject: 'pending'|'generating'|'done'|'error'}
  const [savedItemCount, setSavedItemCount] = useState(0);
  const [done, setDone] = useState(false);
  const [genError, setGenError] = useState("");

  const weekDate = useMemo(() => new Date(weekStartDate + "T00:00:00"), [weekStartDate]);
  const lastWeekIso = useMemo(() => {
    const d = new Date(weekDate);
    d.setDate(d.getDate() - 7);
    return isoLocalDate(d);
  }, [weekDate]);
  const fridayDate = useMemo(() => addDays(weekDate, 4), [weekDate]);
  const weekRangeStr = `${fmtMonthDay(weekDate)} – ${fmtMonthDay(fridayDate)}, ${weekDate.getFullYear()}`;

  // Load up everything
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError("");
      try {
        const [last, current, schedule, checkpoint] = await Promise.all([
          onLoadSemesterPlanWeekFor({ kidId: kid.id, weekStartDate: lastWeekIso }),
          onLoadSemesterPlanWeekFor({ kidId: kid.id, weekStartDate }),
          onLoadScheduleRules(kid.id),
          onLoadWeeklyCheckpoint({ kidId: kid.id, weekStartDate }),
        ]);
        if (cancelled) return;
        setLastWeekTopics(last || {});
        setThisWeekTopics(current || {});
        setSubjectDays(schedule?.subjectDays || {});
        // If there's an existing checkpoint and it's already approved+generated, jump to a "already done" state
        if (checkpoint?.generated_at) {
          setDone(true);
          setStep(3);
        }
      } catch (e) {
        console.error("Sunday planning load:", e);
        if (!cancelled) setLoadError(e.message || "Failed to load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [kid.id, weekStartDate, lastWeekIso]);

  // Subjects that are scheduled this week
  const subjectsThisWeek = useMemo(
    () => (kid.subjects || []).filter(s => orderedScheduleDays(subjectDays[s]).length > 0),
    [kid.subjects, subjectDays]
  );

  const carryoverPerSubject = useMemo(() => {
    const out = {};
    Object.entries(carryoverText).forEach(([subj, txt]) => {
      const status = completionStatus[subj];
      if ((status === "partial" || status === "no") && txt && txt.trim()) {
        out[subj] = txt.trim();
      }
    });
    return out;
  }, [carryoverText, completionStatus]);

  // Subjects that show on the carryover step (i.e., had something last week)
  const lastWeekSubjects = (kid.subjects || []).filter(s => lastWeekTopics[s]);

  // ── Step 1 → Step 2 ──
  const handleStep1Next = async () => {
    const lines = [];
    Object.entries(carryoverPerSubject).forEach(([subj, note]) => {
      lines.push(`${subj}: ${note}`);
    });
    const notes = lines.join("\n\n");
    try {
      await onSaveWeeklyCheckpoint({
        kidId: kid.id,
        weekStartDate,
        carryoverNotes: notes || null,
      });
      setStep(2);
    } catch (e) {
      console.error(e);
      alert("Couldn't save carryover: " + (e.message || "unknown error"));
    }
  };

  // ── Step 2 → Step 3 ──
  const handleStep2Approve = async () => {
    try {
      await onSaveWeeklyCheckpoint({
        kidId: kid.id,
        weekStartDate,
        approvedAt: new Date().toISOString(),
      });
      setStep(3);
    } catch (e) {
      console.error(e);
      alert("Couldn't save approval: " + (e.message || "unknown error"));
    }
  };

  // ── Step 3 generate ──
  const updateThisWeekTopic = (subject, field, value) => {
    setThisWeekTopics(prev => ({
      ...prev,
      [subject]: { ...(prev[subject] || {}), [field]: value },
    }));
  };

  const generateAll = async () => {
    setGenerating(true);
    setGenError("");
    setProgress(Object.fromEntries(subjectsThisWeek.map(s => [s, "pending"])));
    const collected = [];

    for (const subject of subjectsThisWeek) {
      setProgress(prev => ({ ...prev, [subject]: "generating" }));
      const days = orderedScheduleDays(subjectDays[subject]);
      const dayCount = days.length;
      const tdata = thisWeekTopics[subject] || {};
      const topic = (tdata.topic || `Week's content`).trim();
      const description = (tdata.description || "").trim();
      const carryover = carryoverPerSubject[subject];

      // Build the per-task list for this subject
      const tasks = [];
      tasks.push({ tool: TOOLS.find(t => t.id === "worksheet"), assignDay: days[0] });
      if (dayCount > 2) {
        tasks.push({ tool: TOOLS.find(t => t.id === "lesson"), assignDay: days[Math.min(1, days.length - 1)] });
      }
      // Quiz on the last scheduled day of this subject (when there is one)
      if (dayCount > 0) {
        tasks.push({ tool: TOOLS.find(t => t.id === "quiz"), assignDay: days[days.length - 1] });
      }

      try {
        for (const t of tasks) {
          const promptText = buildSundayPrompt(t.tool, kid, subject, topic, description, carryover);
          const res = await fetch("/api/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              max_tokens: 4096,
              messages: [{ role: "user", content: promptText }],
            }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data?.error || "API error");
          const text = (data.content || []).map(b => b.text || "").join("");
          collected.push({
            day: t.assignDay,
            subject,
            task_title: `${t.tool.title}: ${topic}`,
            content: text,
          });
        }
        setProgress(prev => ({ ...prev, [subject]: "done" }));
      } catch (e) {
        console.error(`Gen error for ${subject}:`, e);
        setProgress(prev => ({ ...prev, [subject]: "error" }));
      }
    }

    if (collected.length === 0) {
      setGenError("No materials were generated. Check your network and try again.");
      setGenerating(false);
      return;
    }

    try {
      await onSaveLessonPlan({ kidId: kid.id, weekStartDate, items: collected });
      await onSaveWeeklyCheckpoint({
        kidId: kid.id,
        weekStartDate,
        generatedAt: new Date().toISOString(),
      });
      setSavedItemCount(collected.length);
      setDone(true);
    } catch (e) {
      console.error(e);
      setGenError("Couldn't save the generated plan: " + (e.message || "unknown error"));
    } finally {
      setGenerating(false);
    }
  };

  // ── Render ──
  const overlayStyle = {
    position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)",
    zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
  };
  const cardStyle = {
    background: "var(--cream, #FDF8F3)", borderRadius: 16, width: "100%", maxWidth: 720,
    maxHeight: "90vh", display: "flex", flexDirection: "column", boxShadow: "0 16px 48px rgba(0,0,0,0.2)",
  };
  const headerStyle = {
    padding: "18px 24px 12px", borderBottom: "1px solid var(--cream-dark, #F2E9DC)",
    display: "flex", alignItems: "center", justifyContent: "space-between",
  };
  const bodyStyle = { padding: "16px 24px 20px", overflowY: "auto", flex: 1 };
  const footerStyle = { padding: "12px 24px 18px", borderTop: "1px solid var(--cream-dark, #F2E9DC)", display: "flex", gap: 12 };

  return (
    <div style={overlayStyle} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={cardStyle}>
        <div style={headerStyle}>
          <div>
            <div style={{ fontSize: "0.78rem", color: "var(--text-muted, #8A7968)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em" }}>
              Sunday Planning · {kid.name} · Week of {fmtMonthDay(weekDate)}
            </div>
            <h2 style={{ margin: "4px 0 0", fontSize: "1.4rem", color: "var(--green, #4A7C5F)" }}>
              {step === 1 && "Carryover Check"}
              {step === 2 && "This Week's Plan"}
              {step === 3 && (done ? "All Set!" : "Generate Materials")}
            </h2>
          </div>
          <button
            onClick={onClose}
            style={{ background: "transparent", border: 0, fontSize: "1.4rem", cursor: "pointer", color: "var(--text-muted, #8A7968)", padding: 4 }}
            title="Close"
          >×</button>
        </div>

        <div style={bodyStyle}>
          {loading && <div style={{ padding: 32, textAlign: "center", color: "var(--text-muted, #8A7968)" }}>Loading...</div>}
          {loadError && !loading && (
            <div style={{ background: "#fde8e8", color: "#c0392b", borderRadius: 8, padding: "10px 14px", fontSize: "0.85rem" }}>⚠️ {loadError}</div>
          )}

          {!loading && !loadError && step === 1 && (
            <>
              {lastWeekSubjects.length === 0 ? (
                <div style={{ padding: 16, background: "var(--green-pale, #EDF5F0)", color: "var(--green, #4A7C5F)", borderRadius: 10, lineHeight: 1.5 }}>
                  No semester plan entries for last week — looks like this is the first week. We'll skip the carryover check.
                </div>
              ) : (
                lastWeekSubjects.map(subject => {
                  const last = lastWeekTopics[subject];
                  const status = completionStatus[subject];
                  const showCarryover = status === "partial" || status === "no";
                  return (
                    <div key={subject} style={{ background: "#fff", border: "1px solid var(--cream-dark, #F2E9DC)", borderRadius: 12, padding: 14, marginBottom: 12 }}>
                      <div style={{ fontWeight: 700, fontSize: "0.95rem", marginBottom: 4 }}>{subject}</div>
                      <div style={{ fontSize: "0.85rem", color: "var(--text-muted, #8A7968)", marginBottom: 10 }}>
                        Last week: <strong style={{ color: "#333" }}>{last.topic}</strong>
                        {last.description ? ` — ${last.description}` : ""}
                      </div>
                      <div style={{ fontSize: "0.85rem", marginBottom: 8 }}>Did {kid.name} complete this?</div>
                      <div style={{ display: "flex", gap: 8, marginBottom: showCarryover ? 10 : 0 }}>
                        {[
                          { id: "yes", label: "Yes" },
                          { id: "partial", label: "Partially" },
                          { id: "no", label: "No" },
                        ].map(opt => {
                          const active = status === opt.id;
                          return (
                            <button
                              key={opt.id}
                              type="button"
                              onClick={() => setCompletionStatus(prev => ({ ...prev, [subject]: opt.id }))}
                              style={{
                                border: 0, borderRadius: 999, padding: "7px 14px", cursor: "pointer", fontSize: "0.85rem", fontWeight: 700,
                                background: active ? "var(--green, #4A7C5F)" : "var(--cream-dark, #F2E9DC)",
                                color: active ? "#fff" : "#666",
                              }}
                            >
                              {opt.label}
                            </button>
                          );
                        })}
                      </div>
                      {showCarryover && (
                        <textarea
                          rows={2}
                          placeholder="What do you want to carry over to this week?"
                          value={carryoverText[subject] || ""}
                          onChange={e => setCarryoverText(prev => ({ ...prev, [subject]: e.target.value }))}
                          style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "1px solid var(--cream-dark, #F2E9DC)", fontFamily: "inherit", fontSize: "0.88rem", resize: "vertical" }}
                        />
                      )}
                    </div>
                  );
                })
              )}
            </>
          )}

          {!loading && !loadError && step === 2 && (
            <>
              <div style={{ fontSize: "0.88rem", color: "var(--text-muted, #8A7968)", marginBottom: 12 }}>
                Week of {weekRangeStr}. Edit any topic before we generate.
              </div>
              {subjectsThisWeek.length === 0 ? (
                <div style={{ padding: 16, background: "#fff8e1", color: "#7c6a00", borderRadius: 10, lineHeight: 1.5 }}>
                  No subjects are scheduled this week. Add days to your schedule rules in Students → Profile.
                </div>
              ) : (
                subjectsThisWeek.map(subject => {
                  const tdata = thisWeekTopics[subject] || {};
                  const days = orderedScheduleDays(subjectDays[subject]);
                  const carry = carryoverPerSubject[subject];
                  return (
                    <div key={subject} style={{ background: "#fff", border: "1px solid var(--cream-dark, #F2E9DC)", borderRadius: 12, padding: 14, marginBottom: 12 }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6, gap: 8, flexWrap: "wrap" }}>
                        <div style={{ fontWeight: 700, fontSize: "0.95rem" }}>{subject}</div>
                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                          {days.length === 0 && <span style={{ fontSize: "0.72rem", color: "#999" }}>Not scheduled</span>}
                          {days.map(d => (
                            <span key={d} style={{ fontSize: "0.72rem", fontWeight: 700, background: "var(--green-pale, #EDF5F0)", color: "var(--green, #4A7C5F)", padding: "3px 8px", borderRadius: 999 }}>
                              {d.slice(0, 3)}
                            </span>
                          ))}
                        </div>
                      </div>
                      {carry && (
                        <div style={{ fontSize: "0.78rem", background: "#fff4e0", color: "#8a5a00", borderRadius: 8, padding: "6px 10px", marginBottom: 8 }}>
                          ↩️ Carryover: {carry}
                        </div>
                      )}
                      <input
                        value={tdata.topic || ""}
                        onChange={e => updateThisWeekTopic(subject, "topic", e.target.value)}
                        placeholder="Topic for this week"
                        style={{ width: "100%", fontSize: "0.95rem", fontWeight: 700, padding: "6px 8px", border: "1px solid var(--cream-dark, #F2E9DC)", borderRadius: 6, marginBottom: 6 }}
                      />
                      <textarea
                        value={tdata.description || ""}
                        onChange={e => updateThisWeekTopic(subject, "description", e.target.value)}
                        placeholder="What to cover (optional notes)"
                        rows={2}
                        style={{ width: "100%", fontSize: "0.85rem", padding: "6px 8px", border: "1px solid var(--cream-dark, #F2E9DC)", borderRadius: 6, resize: "vertical", fontFamily: "inherit", lineHeight: 1.4 }}
                      />
                    </div>
                  );
                })
              )}
            </>
          )}

          {!loading && !loadError && step === 3 && (
            <>
              {!done && !generating && (
                <>
                  <p style={{ marginBottom: 16, color: "var(--text-muted, #8A7968)" }}>
                    Ready to generate materials for {subjectsThisWeek.length} subject{subjectsThisWeek.length === 1 ? "" : "s"} this week. Each subject gets a worksheet, plus a lesson plan if it runs 3+ days, plus a quiz on the last scheduled day.
                  </p>
                </>
              )}
              {(generating || done || Object.keys(progress).length > 0) && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
                  {subjectsThisWeek.map(subject => {
                    const st = progress[subject] || "pending";
                    const icon = st === "done" ? "✅" : st === "generating" ? "⏳" : st === "error" ? "⚠️" : "○";
                    return (
                      <div key={subject} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderRadius: 8, background: "#fff", border: "1px solid var(--cream-dark, #F2E9DC)" }}>
                        <span style={{ fontSize: "1.05rem" }}>{icon}</span>
                        <span style={{ fontWeight: 700 }}>{subject}</span>
                        <span style={{ fontSize: "0.78rem", color: "var(--text-muted, #8A7968)", marginLeft: "auto" }}>
                          {st === "generating" ? "Generating..." : st === "done" ? "Ready" : st === "error" ? "Failed" : ""}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
              {genError && (
                <div style={{ background: "#fde8e8", color: "#c0392b", borderRadius: 8, padding: "10px 14px", fontSize: "0.85rem", marginBottom: 12 }}>⚠️ {genError}</div>
              )}
              {done && (
                <div style={{ background: "var(--green-pale, #EDF5F0)", color: "var(--green, #4A7C5F)", borderRadius: 10, padding: "14px 18px", lineHeight: 1.6 }}>
                  <div style={{ fontWeight: 700, fontSize: "1.05rem", marginBottom: 4 }}>This week is ready! 🎉</div>
                  <div>{kid.name} has {savedItemCount} assignment{savedItemCount === 1 ? "" : "s"} waiting.</div>
                </div>
              )}
            </>
          )}
        </div>

        <div style={footerStyle}>
          {!loading && !loadError && step === 1 && (
            <>
              <button className="btn-secondary" onClick={onClose}>Cancel</button>
              <button className="btn-primary" style={{ flex: 1 }} onClick={handleStep1Next}>Next →</button>
            </>
          )}
          {!loading && !loadError && step === 2 && (
            <>
              <button className="btn-secondary" onClick={() => setStep(1)}>← Back</button>
              <button className="btn-primary" style={{ flex: 1 }} onClick={handleStep2Approve} disabled={subjectsThisWeek.length === 0}>
                Approve & Continue →
              </button>
            </>
          )}
          {!loading && !loadError && step === 3 && !done && (
            <>
              <button className="btn-secondary" onClick={() => setStep(2)} disabled={generating}>← Back</button>
              <button className="btn-primary" style={{ flex: 1 }} onClick={generateAll} disabled={generating || subjectsThisWeek.length === 0}>
                {generating ? "Generating..." : "Generate All Materials"}
              </button>
            </>
          )}
          {done && (
            <button className="btn-primary" style={{ flex: 1 }} onClick={onClose}>Back to Dashboard</button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Semester Plan Modal (view-only by default; edits require typing CONFIRM) ─
function SemesterPlanModal({ kid, onClose, onLoadSemesterPlanWeeksForKid, onUpdateSemesterPlanWeek }) {
  const [groups, setGroups] = useState({});       // { subject: {planId, weeks: [...]} }
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  // Edit-flow state. We progress: pendingEditId (warning shown) → unlockedEditId (form shown)
  const [pendingEditId, setPendingEditId] = useState(null); // week id awaiting CONFIRM
  const [confirmText, setConfirmText] = useState("");
  const [unlockedEditId, setUnlockedEditId] = useState(null);
  const [draftTopic, setDraftTopic] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [savingId, setSavingId] = useState(null);
  const [saveError, setSaveError] = useState("");

  const reload = async () => {
    setLoading(true);
    setLoadError("");
    try {
      const data = await onLoadSemesterPlanWeeksForKid({ kidId: kid.id });
      setGroups(data || {});
    } catch (e) {
      console.error(e);
      setLoadError(e.message || "Failed to load");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { let cancelled = false; (async () => { if (!cancelled) await reload(); })(); return () => { cancelled = true; }; }, [kid.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const findWeekById = (id) => {
    for (const g of Object.values(groups)) {
      const w = g.weeks.find(x => x.id === id);
      if (w) return w;
    }
    return null;
  };

  const startEditFlow = (week) => {
    setPendingEditId(week.id);
    setConfirmText("");
    setUnlockedEditId(null);
    setSaveError("");
  };

  const cancelEditFlow = () => {
    setPendingEditId(null);
    setConfirmText("");
    setUnlockedEditId(null);
    setSaveError("");
  };

  const unlockEdit = () => {
    const w = findWeekById(pendingEditId);
    if (!w) return;
    setDraftTopic(w.topic || "");
    setDraftDescription(w.description || "");
    setUnlockedEditId(pendingEditId);
    setPendingEditId(null);
    setConfirmText("");
  };

  const saveEdit = async () => {
    setSavingId(unlockedEditId);
    setSaveError("");
    try {
      await onUpdateSemesterPlanWeek({
        id: unlockedEditId,
        topic: draftTopic,
        description: draftDescription,
      });
      setUnlockedEditId(null);
      setDraftTopic("");
      setDraftDescription("");
      await reload();
    } catch (e) {
      console.error(e);
      setSaveError(e.message || "Couldn't save.");
    } finally {
      setSavingId(null);
    }
  };

  const overlay = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 };
  const card = { background: "var(--cream, #FDF8F3)", borderRadius: 16, width: "100%", maxWidth: 720, maxHeight: "90vh", display: "flex", flexDirection: "column", boxShadow: "0 16px 48px rgba(0,0,0,0.2)" };
  const header = { padding: "18px 24px 12px", borderBottom: "1px solid var(--cream-dark, #F2E9DC)", display: "flex", alignItems: "center", justifyContent: "space-between" };
  const body = { padding: "16px 24px 20px", overflowY: "auto", flex: 1 };

  const subjectNames = Object.keys(groups);
  const totalWeeks = subjectNames.reduce((sum, s) => sum + (groups[s].weeks?.length || 0), 0);

  return (
    <div style={overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={card}>
        <div style={header}>
          <div>
            <div style={{ fontSize: "0.78rem", color: "var(--text-muted, #8A7968)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em" }}>
              Semester Plan · {kid.name}
            </div>
            <h2 style={{ margin: "4px 0 0", fontSize: "1.4rem", color: "var(--green, #4A7C5F)" }}>
              {totalWeeks} week{totalWeeks === 1 ? "" : "s"} across {subjectNames.length} subject{subjectNames.length === 1 ? "" : "s"}
            </h2>
          </div>
          <button onClick={onClose} style={{ background: "transparent", border: 0, fontSize: "1.4rem", cursor: "pointer", color: "var(--text-muted, #8A7968)", padding: 4 }}>×</button>
        </div>

        <div style={body}>
          {loading && <div style={{ padding: 32, textAlign: "center", color: "var(--text-muted, #8A7968)" }}>Loading...</div>}
          {loadError && !loading && (
            <div style={{ background: "#fde8e8", color: "#c0392b", borderRadius: 8, padding: "10px 14px", fontSize: "0.85rem" }}>⚠️ {loadError}</div>
          )}
          {!loading && !loadError && subjectNames.length === 0 && (
            <div style={{ padding: 16, background: "var(--green-pale, #EDF5F0)", color: "var(--green, #4A7C5F)", borderRadius: 10, lineHeight: 1.5 }}>
              No semester plan yet for {kid.name}. Run the setup flow to build one.
            </div>
          )}
          {!loading && !loadError && subjectNames.map(subject => {
            const g = groups[subject];
            return (
              <div key={subject} style={{ marginBottom: 18 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
                  <h3 style={{ margin: 0, fontSize: "1.05rem", color: "var(--green, #4A7C5F)" }}>{subject}</h3>
                  {g.curriculumName && <span style={{ fontSize: "0.78rem", color: "var(--text-muted, #8A7968)" }}>{g.curriculumName}</span>}
                </div>
                {g.weeks.length === 0 && (
                  <div style={{ fontSize: "0.85rem", color: "var(--text-muted, #8A7968)" }}>No weeks saved.</div>
                )}
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {g.weeks.map(w => {
                    const isUnlocked = unlockedEditId === w.id;
                    const isPending = pendingEditId === w.id;
                    return (
                      <div key={w.id} style={{ background: "#fff", border: "1px solid var(--cream-dark, #F2E9DC)", borderRadius: 12, padding: 12 }}>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
                          <div style={{ fontSize: "0.74rem", color: "var(--text-muted, #8A7968)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                            Week {w.weekNumber}{w.weekStartDate ? ` · ${w.weekStartDate}` : ""}
                          </div>
                          {!isUnlocked && (
                            <button
                              onClick={() => startEditFlow(w)}
                              title="Edit this week"
                              style={{ background: "transparent", border: 0, color: "var(--text-muted, #8A7968)", cursor: "pointer", fontSize: "0.95rem", padding: "4px 8px", borderRadius: 6 }}
                              onMouseEnter={e => e.currentTarget.style.background = "var(--cream-dark, #F2E9DC)"}
                              onMouseLeave={e => e.currentTarget.style.background = "transparent"}
                            >
                              ✏️ Edit
                            </button>
                          )}
                        </div>
                        {!isUnlocked ? (
                          <>
                            <div style={{ fontWeight: 700, fontSize: "0.95rem", marginBottom: 4 }}>{w.topic || <em style={{ color: "var(--text-muted, #8A7968)" }}>(no topic)</em>}</div>
                            {w.description && <div style={{ fontSize: "0.85rem", color: "#444", lineHeight: 1.45 }}>{w.description}</div>}
                          </>
                        ) : (
                          <div>
                            <input
                              value={draftTopic}
                              onChange={e => setDraftTopic(e.target.value)}
                              placeholder="Topic"
                              style={{ width: "100%", fontSize: "0.95rem", fontWeight: 700, padding: "6px 8px", border: "1px solid var(--green, #4A7C5F)", borderRadius: 6, marginBottom: 6 }}
                            />
                            <textarea
                              value={draftDescription}
                              onChange={e => setDraftDescription(e.target.value)}
                              placeholder="Description"
                              rows={3}
                              style={{ width: "100%", fontSize: "0.85rem", padding: "6px 8px", border: "1px solid var(--green, #4A7C5F)", borderRadius: 6, resize: "vertical", fontFamily: "inherit", lineHeight: 1.45 }}
                            />
                            {saveError && (
                              <div style={{ background: "#fde8e8", color: "#c0392b", borderRadius: 8, padding: "6px 10px", fontSize: "0.8rem", marginTop: 6 }}>⚠️ {saveError}</div>
                            )}
                            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                              <button className="btn-secondary" onClick={cancelEditFlow} disabled={savingId === w.id}>Cancel</button>
                              <button
                                className="btn-primary"
                                style={{ width: "auto", padding: "8px 16px" }}
                                onClick={saveEdit}
                                disabled={savingId === w.id}
                              >
                                {savingId === w.id ? "Saving..." : "Save Changes"}
                              </button>
                            </div>
                          </div>
                        )}
                        {isPending && (
                          <ConfirmEditWarning
                            week={w}
                            confirmText={confirmText}
                            onConfirmTextChange={setConfirmText}
                            onUnlock={unlockEdit}
                            onCancel={cancelEditFlow}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ConfirmEditWarning({ week, confirmText, onConfirmTextChange, onUnlock, onCancel }) {
  const overlay = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", zIndex: 1100, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 };
  const card = { background: "#fff", borderRadius: 14, maxWidth: 480, width: "100%", padding: "20px 22px", boxShadow: "0 16px 48px rgba(0,0,0,0.3)" };
  const okToProceed = confirmText.trim().toUpperCase() === "CONFIRM";
  return (
    <div style={overlay} onClick={e => e.target === e.currentTarget && onCancel()}>
      <div style={card}>
        <div style={{ fontSize: "1.05rem", fontWeight: 700, marginBottom: 10 }}>
          ⚠️ Editing Week {week.weekNumber} will affect your semester plan.
        </div>
        <div style={{ fontSize: "0.9rem", lineHeight: 1.55, color: "#333", marginBottom: 12 }}>
          Changing this week's topic may cause the following weeks to fall out of sequence with your curriculum. HomeRoom cannot automatically adjust subsequent weeks.
        </div>
        <div style={{ fontSize: "0.85rem", lineHeight: 1.55, color: "#333", marginBottom: 6 }}>
          We recommend only editing if:
        </div>
        <ul style={{ margin: "0 0 12px 20px", padding: 0, fontSize: "0.85rem", color: "#333", lineHeight: 1.55 }}>
          <li>Your class covered more or less than planned</li>
          <li>You need to swap topics between weeks</li>
          <li>You are intentionally restructuring your curriculum</li>
        </ul>
        <div style={{ background: "#fff4e0", color: "#7c5400", borderRadius: 8, padding: "10px 12px", fontSize: "0.85rem", marginBottom: 14 }}>
          This change cannot be undone automatically.
        </div>
        <label style={{ display: "block", fontSize: "0.82rem", fontWeight: 700, color: "var(--text-muted, #8A7968)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em" }}>
          Type <strong style={{ color: "#c0392b" }}>CONFIRM</strong> to proceed
        </label>
        <input
          autoFocus
          value={confirmText}
          onChange={e => onConfirmTextChange(e.target.value)}
          placeholder="CONFIRM"
          style={{ width: "100%", padding: "8px 12px", borderRadius: 8, border: "1px solid var(--cream-dark, #F2E9DC)", fontSize: "0.95rem", letterSpacing: "0.05em", marginBottom: 14 }}
          onKeyDown={e => { if (e.key === "Enter" && okToProceed) onUnlock(); }}
        />
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn-secondary" onClick={onCancel}>Cancel</button>
          <button
            className="btn-primary"
            style={{ flex: 1, opacity: okToProceed ? 1 : 0.5 }}
            disabled={!okToProceed}
            onClick={onUnlock}
          >
            Unlock Edit →
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Help Chat ───────────────────────────────────────────────────────────────
// Single source of truth for what the in-app help bot knows. Keep this in sync
// whenever a new feature ships — that's the maintenance cost of this approach.
const HELP_SYSTEM_PROMPT = `You are HomeRoom's friendly built-in help assistant. HomeRoom is a homeschool planning app for parents (the "teacher") and their kids (the "students").

Your job: answer questions about how to use HomeRoom. Be concise, warm, and specific — point to the exact tab and button. Use bullet steps when there's a click path. If a feature doesn't exist yet, say so honestly. Don't invent features.

Style: short answers (2–4 sentences usually). When listing steps, use numbered or dashed bullets, not paragraphs.

Here's how HomeRoom is laid out:

# Top-level navigation (4 tabs across the top)
- Dashboard — at-a-glance home: greeting, Sunday Planning banner (when applicable), suggestion banner, kids row, and the Generate Materials grid.
- Students — pick a kid via the pills at the top, see their profile, schedule rules, weekly plan, and semester plan.
- Generate — same tools grid as the Dashboard, for going straight to creating a worksheet, quiz, lesson plan, or study guide.
- History — past weekly plans (with progress bars) and past generated materials (filterable by type).

# First-time setup (5 steps)
When a new account first signs in, a setup flow runs:
1. Welcome
2. Add a Student — name, grade, learning style, subjects
3. Semester Dates & Break Weeks — pick start/end dates; toggle each week as School or Break
4. Build My Semester — for each subject: type the curriculum name, pick days/week (1–5), optional PDF upload (DOCX accepted but contents not read), then "Generate Semester Plan". Edit the AI's week-by-week plan inline, then "Looks Good — Lock It In"
5. Confirmation — click "Enter HomeRoom"

# Sunday Planning
A green banner appears on the Dashboard on Sundays, OR on any day this week has no plan yet. Each kid that needs planning gets their own banner. Click "Start Sunday Planning" to open a 3-step modal:
1. Carryover Check — for each subject, "Did [kid] complete [last week's topic]?" (Yes / Partially / No). Picking Partially or No reveals a carryover note field.
2. This Week's Plan — preview each subject's topic for the week; edit topic and description inline; carryovers show as orange badges; scheduled days show as green pills.
3. Generate All Materials — generates a worksheet (always), a lesson plan (if 3+ days/week), and a quiz (assigned to the last scheduled day) for each subject. Saves everything to that week's lesson plan.

# Generating individual materials
Open any tool from the Dashboard or Generate tab. Pick student → subject → topic → click Generate. After the content appears:
- Click "Assign & Copy Link" with a date — creates a shareable URL at /a/<token> that the student opens on their device.
- Below, the Resource Links section unlocks. Add labeled URL rows (e.g. "Watch this first" → YouTube). Save Links writes them to that specific assignment.

# Editing the locked semester plan
Students tab → pick the kid → "📅 View Semester Plan" button at the top right of their profile header. The modal lists every week grouped by subject. Each week has a small "✏️ Edit" icon. Editing requires typing the word CONFIRM in a warning dialog (this is intentional — HomeRoom doesn't auto-cascade changes to subsequent weeks).

# Schedule rules (which days each subject runs)
Students tab → kid profile → there's a Schedule Rules section. Tell HomeRoom which days each subject runs (Mon/Tue/Wed/Thu/Fri). Sunday Planning uses these to decide where to assign worksheets/lessons/quizzes.

# Public assignment page (the kid's view)
The kid (no login) opens /a/<token> on their device. They see the task title, any resource links as warm green cards, the assignment content, and a "Mark Complete ✓" button. Once marked complete, the parent sees it reflected in their plan.

# History tab
Two segments at the top: "Weekly Plans" (past weeks with completion progress bars — clicking one jumps to that week in the Students tab) and "Generated Materials" (every individual worksheet/quiz/etc, filterable by type).

# Things HomeRoom does NOT do yet
- Multiple parents on one account / shared classrooms
- Grading or rubric feedback
- Real DOCX text extraction (PDFs read fully; DOCX is accepted but only the filename + curriculum name are used)
- Email or SMS reminders
- A native mobile app (the web app works on mobile browsers)

If a user asks about something not listed above, say honestly: "That's not in HomeRoom right now — but you can ask the developer to add it."`;

function HelpChat() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]); // {role: 'user'|'assistant', content: string}
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, loading, open]);

  const send = async () => {
    const text = input.trim();
    if (!text || loading) return;
    const next = [...messages, { role: "user", content: text }];
    setMessages(next);
    setInput("");
    setLoading(true);
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          max_tokens: 1024,
          system: HELP_SYSTEM_PROMPT,
          messages: next.map(m => ({ role: m.role, content: m.content })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "API error");
      const reply = (data.content || []).map(b => b.text || "").join("") || "Sorry, I didn't get a reply. Try again?";
      setMessages(prev => [...prev, { role: "assistant", content: reply }]);
    } catch (e) {
      console.error(e);
      setMessages(prev => [...prev, { role: "assistant", content: "Hmm, I couldn't reach the help service. Check your connection and try again." }]);
    } finally {
      setLoading(false);
    }
  };

  const fab = {
    position: "fixed", right: 22, bottom: 22, zIndex: 950,
    width: 56, height: 56, borderRadius: "50%", border: 0, cursor: "pointer",
    background: "var(--green, #4A7C5F)", color: "#fff", fontSize: "1.5rem",
    boxShadow: "0 6px 18px rgba(74,124,95,0.35)",
    display: "flex", alignItems: "center", justifyContent: "center",
  };

  const panel = {
    position: "fixed", right: 22, bottom: 22, zIndex: 950,
    width: "min(380px, calc(100vw - 28px))",
    height: "min(560px, calc(100vh - 100px))",
    background: "var(--cream, #FDF8F3)",
    borderRadius: 16,
    boxShadow: "0 16px 48px rgba(0,0,0,0.22)",
    display: "flex", flexDirection: "column", overflow: "hidden",
    border: "1px solid var(--cream-dark, #F2E9DC)",
  };

  const headerRow = {
    padding: "12px 14px",
    background: "var(--green, #4A7C5F)", color: "#fff",
    display: "flex", alignItems: "center", justifyContent: "space-between",
  };

  const messageList = {
    flex: 1, overflowY: "auto", padding: 12,
    display: "flex", flexDirection: "column", gap: 8,
  };

  const userBubble = {
    alignSelf: "flex-end", maxWidth: "85%",
    background: "var(--green, #4A7C5F)", color: "#fff",
    padding: "8px 12px", borderRadius: 14, borderBottomRightRadius: 4,
    fontSize: "0.88rem", lineHeight: 1.45, whiteSpace: "pre-wrap", wordBreak: "break-word",
  };

  const botBubble = {
    alignSelf: "flex-start", maxWidth: "90%",
    background: "#fff", border: "1px solid var(--cream-dark, #F2E9DC)",
    padding: "8px 12px", borderRadius: 14, borderBottomLeftRadius: 4,
    fontSize: "0.88rem", lineHeight: 1.5, color: "#333",
    whiteSpace: "pre-wrap", wordBreak: "break-word",
  };

  const inputRow = {
    padding: 10, borderTop: "1px solid var(--cream-dark, #F2E9DC)",
    display: "flex", gap: 8, background: "#fff",
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={fab}
        title="Help"
        aria-label="Open help chat"
      >
        💬
      </button>
    );
  }

  return (
    <div style={panel}>
      <div style={headerRow}>
        <div>
          <div style={{ fontSize: "0.72rem", opacity: 0.85, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em" }}>HomeRoom Help</div>
          <div style={{ fontSize: "0.95rem", fontWeight: 700 }}>Ask me how to use the site</div>
        </div>
        <button
          onClick={() => setOpen(false)}
          aria-label="Close help"
          style={{ background: "transparent", border: 0, color: "#fff", fontSize: "1.3rem", cursor: "pointer", padding: 4, lineHeight: 1 }}
        >×</button>
      </div>

      <div ref={scrollRef} style={messageList}>
        {messages.length === 0 && (
          <div style={{ ...botBubble, alignSelf: "stretch", maxWidth: "100%" }}>
            👋 Hi! I'm built into HomeRoom and can answer questions about how to use it.
            {"\n\n"}
            Try asking:
            {"\n"}• "How do I add a break week?"
            {"\n"}• "Where do I edit my semester plan?"
            {"\n"}• "What does Sunday Planning do?"
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} style={m.role === "user" ? userBubble : botBubble}>{m.content}</div>
        ))}
        {loading && (
          <div style={{ ...botBubble, color: "var(--text-muted, #8A7968)", fontStyle: "italic" }}>thinking...</div>
        )}
      </div>

      <div style={inputRow}>
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Ask a question..."
          rows={1}
          style={{
            flex: 1, resize: "none", border: "1px solid var(--cream-dark, #F2E9DC)",
            borderRadius: 10, padding: "8px 10px", fontFamily: "inherit", fontSize: "0.88rem",
            lineHeight: 1.4, maxHeight: 100,
          }}
        />
        <button
          onClick={send}
          disabled={loading || !input.trim()}
          className="btn-primary"
          style={{ width: "auto", padding: "8px 14px", fontSize: "0.85rem" }}
        >
          Send
        </button>
      </div>
    </div>
  );
}

function Dashboard({
  user, kids, semesterDates, lessonPlans, onAddKid,
  onSaveGeneration, onDeleteGeneration, onSaveCurriculum,
  onLoadScheduleRules, onSaveScheduleRules,
  onLoadLessonPlan, onSaveLessonPlan, onAssignLessonPlanItem,
  onAssignGenerationToPlan,
  onLoadSemesterPlanWeekFor, onLoadSemesterPlanWeeksForKid, onUpdateSemesterPlanWeek,
  onLoadWeeklyCheckpoint, onSaveWeeklyCheckpoint,
  onUpdateKid, onAddSubject, onDeleteSubject, onUpdateSubjectResources, onUploadAvatar,
  onSignOut
}) {
  const [activeTool, setActiveTool] = useState(null);
  const [activeTab, setActiveTab] = useState("dashboard");
  const [history, setHistory] = useState([]);
  const [viewingItem, setViewingItem] = useState(null);
  const [historyFilter, setHistoryFilter] = useState("all");
  const [historyView, setHistoryView] = useState("plans");
  const [studentViewKidId, setStudentViewKidId] = useState(null);
  const [studentViewWeekStart, setStudentViewWeekStart] = useState(null);
  const [curriculumUploadFor, setCurriculumUploadFor] = useState(null);
  const [planningKidId, setPlanningKidId] = useState(null);
  const [semesterPlanForKidId, setSemesterPlanForKidId] = useState(null);

  // Sunday Planning: this week's Monday + which kids need a plan
  const thisMonday = useMemo(() => getMondayOf(new Date()), []);
  const thisMondayIso = isoLocalDate(thisMonday);
  const isSunday = new Date().getDay() === 0;
  const kidsNeedingPlanning = useMemo(() => {
    return kids.filter(k => {
      const hasPlan = lessonPlans.some(p => p.kidId === k.id && p.weekStartDate === thisMondayIso);
      return !hasPlan || isSunday;
    });
  }, [kids, lessonPlans, thisMondayIso, isSunday]);
  const planningKid = planningKidId ? kids.find(k => k.id === planningKidId) : null;

  // Default to first kid when kids load
  useEffect(() => {
    if (!studentViewKidId && kids.length > 0) setStudentViewKidId(kids[0].id);
  }, [kids, studentViewKidId]);

  // Re-derive the live kid object from props
  const studentViewKid = studentViewKidId ? kids.find(k => k.id === studentViewKidId) : null;

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

            {kidsNeedingPlanning.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 16 }}>
                {kidsNeedingPlanning.map(kid => (
                  <div
                    key={kid.id}
                    style={{
                      background: "linear-gradient(135deg, var(--green, #4A7C5F), #6a9d80)",
                      borderRadius: 14,
                      padding: "16px 18px",
                      color: "#fff",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                      flexWrap: "wrap",
                      boxShadow: "0 4px 14px rgba(74,124,95,0.25)",
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: "0.74rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", opacity: 0.85, marginBottom: 4 }}>
                        🗓️ Sunday Planning
                      </div>
                      <div style={{ fontSize: "1.02rem", fontWeight: 700 }}>
                        Ready to plan {kid.name}'s week?
                      </div>
                    </div>
                    <button
                      onClick={() => setPlanningKidId(kid.id)}
                      style={{
                        background: "#fff",
                        color: "var(--green, #4A7C5F)",
                        border: 0,
                        borderRadius: 999,
                        padding: "9px 18px",
                        fontWeight: 700,
                        fontSize: "0.88rem",
                        cursor: "pointer",
                        whiteSpace: "nowrap",
                      }}
                    >
                      Start Sunday Planning →
                    </button>
                  </div>
                ))}
              </div>
            )}

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
                  <div className="kid-avatar" style={{ padding: 0, overflow: "hidden" }}>
                    {kid.avatarUrl
                      ? <img src={kid.avatarUrl} alt={kid.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                      : kid.emoji}
                  </div>
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
            <div className="student-subnav">
              {kids.map(k => (
                <button
                  key={k.id}
                  className={`student-pill ${k.id === studentViewKidId ? "active" : ""}`}
                  onClick={() => { setStudentViewKidId(k.id); setStudentViewWeekStart(null); }}
                >
                  <div className="student-pill-avatar">
                    {k.avatarUrl
                      ? <img src={k.avatarUrl} alt={k.name} />
                      : <span>{k.emoji}</span>}
                  </div>
                  <span>{k.name}</span>
                </button>
              ))}
              <button className="student-pill add" onClick={onAddKid}>+ Add Student</button>
            </div>

            {studentViewKid ? (
              <>
                <div className="student-page-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                  <div>
                    <h2>{studentViewKid.name}</h2>
                    <div className="student-page-sub">{studentViewKid.grade}{studentViewKid.learningStyle ? ` · ${studentViewKid.learningStyle} learner` : ""}</div>
                  </div>
                  <button
                    className="btn-secondary"
                    style={{ width: "auto", padding: "8px 16px" }}
                    onClick={() => setSemesterPlanForKidId(studentViewKid.id)}
                  >
                    📅 View Semester Plan
                  </button>
                </div>

                <WeeklyPlanModal
                  as="inline"
                  kids={kids}
                  semester={semesterDates}
                  initialKidId={studentViewKid.id}
                  initialWeekStart={studentViewWeekStart}
                  onLoadScheduleRules={onLoadScheduleRules}
                  onLoadPlan={onLoadLessonPlan}
                  onSavePlan={onSaveLessonPlan}
                  onAssignItem={onAssignLessonPlanItem}
                />

                <StudentProfileModal
                  as="inline"
                  kid={studentViewKid}
                  onUpdateKid={onUpdateKid}
                  onAddSubject={onAddSubject}
                  onDeleteSubject={onDeleteSubject}
                  onUpdateSubjectResources={onUpdateSubjectResources}
                  onUploadAvatar={onUploadAvatar}
                  onLoadScheduleRules={onLoadScheduleRules}
                  onSaveScheduleRules={onSaveScheduleRules}
                  onLaunchCurriculumUpload={({ kidId, subject }) => setCurriculumUploadFor({ kidId, subject })}
                />
              </>
            ) : (
              <div className="empty-state">
                <div className="empty-icon">👋</div>
                <h3>No students yet</h3>
                <p>Add a student to get started.</p>
                <button className="btn-primary" style={{ width: "auto", marginTop: 16, padding: "10px 24px" }}
                  onClick={onAddKid}>+ Add Student</button>
              </div>
            )}
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
                          setStudentViewKidId(p.kidId);
                          setStudentViewWeekStart(p.weekStartDate);
                          setActiveTab("students");
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

      {activeTool ? (
        <GenerationModal
          tool={activeTool}
          kids={kids}
          onClose={() => setActiveTool(null)}
          onSave={handleSaveToHistory}
          onAssignToPlan={onAssignGenerationToPlan}
        />
      ) : null}

      {viewingItem && (
        <HistoryViewer
          item={viewingItem}
          onClose={() => setViewingItem(null)}
          onDelete={handleDeleteFromHistory}
          onAssignToPlan={onAssignGenerationToPlan}
        />
      )}

      {curriculumUploadFor && (
        <CurriculumUploadModal
          kids={kids}
          onClose={() => setCurriculumUploadFor(null)}
          onSave={async ({ kidId, subject, weeks }) => {
            await handleCurriculumSave({ kidId, subject, weeks });
          }}
          initialKidId={curriculumUploadFor.kidId}
          initialSubject={curriculumUploadFor.subject}
        />
      )}

      {planningKid && (
        <SundayPlanningFlow
          key={`${planningKid.id}-${thisMondayIso}`}
          kid={planningKid}
          weekStartDate={thisMondayIso}
          onLoadScheduleRules={onLoadScheduleRules}
          onLoadSemesterPlanWeekFor={onLoadSemesterPlanWeekFor}
          onLoadWeeklyCheckpoint={onLoadWeeklyCheckpoint}
          onSaveWeeklyCheckpoint={onSaveWeeklyCheckpoint}
          onSaveLessonPlan={onSaveLessonPlan}
          onClose={() => setPlanningKidId(null)}
        />
      )}

      {semesterPlanForKidId && (() => {
        const kid = kids.find(k => k.id === semesterPlanForKidId);
        if (!kid) return null;
        return (
          <SemesterPlanModal
            key={kid.id}
            kid={kid}
            onClose={() => setSemesterPlanForKidId(null)}
            onLoadSemesterPlanWeeksForKid={onLoadSemesterPlanWeeksForKid}
            onUpdateSemesterPlanWeek={onUpdateSemesterPlanWeek}
          />
        );
      })()}

      <HelpChat />
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
        .select("id, day, subject, task_title, content, status, assignment_token, resource_links")
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
            {Array.isArray(item.resource_links) && item.resource_links.length > 0 && (
              <div style={{ margin: "0 0 18px" }}>
                <div style={{ fontSize: "0.85rem", fontWeight: 700, color: "var(--green, #4A7C5F)", marginBottom: 8 }}>
                  Your teacher included these resources for you:
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {item.resource_links.map((link, i) => (
                    <a
                      key={i}
                      href={link.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 12,
                        padding: "12px 14px",
                        borderRadius: 12,
                        background: "linear-gradient(135deg, var(--green-pale, #EDF5F0), #DCEFE0)",
                        border: "1px solid var(--green, #4A7C5F)",
                        textDecoration: "none",
                        color: "var(--green, #4A7C5F)",
                        transition: "transform 120ms ease, box-shadow 120ms ease",
                      }}
                      onMouseEnter={e => { e.currentTarget.style.transform = "translateY(-1px)"; e.currentTarget.style.boxShadow = "0 4px 12px rgba(74,124,95,0.18)"; }}
                      onMouseLeave={e => { e.currentTarget.style.transform = ""; e.currentTarget.style.boxShadow = ""; }}
                    >
                      <span style={{ fontSize: "1.3rem", lineHeight: 1, flexShrink: 0 }}>🔗</span>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: "block", fontWeight: 700, fontSize: "0.95rem", color: "var(--green, #4A7C5F)" }}>
                          {link.label || link.url}
                        </span>
                        {link.label && link.url && (
                          <span style={{ display: "block", fontSize: "0.78rem", color: "var(--text-muted, #8A7968)", marginTop: 2, wordBreak: "break-all" }}>
                            {link.url}
                          </span>
                        )}
                      </span>
                      <span style={{ fontSize: "0.95rem", flexShrink: 0 }}>↗</span>
                    </a>
                  ))}
                </div>
              </div>
            )}
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
    saveKid, saveSemester, saveCurriculumWeeks, saveSemesterPlan,
    loadSemesterPlanWeekFor, loadSemesterPlanWeeksForKid, updateSemesterPlanWeek,
    loadWeeklyCheckpoint, saveWeeklyCheckpoint,
    saveGeneration, deleteGeneration,
    loadScheduleRules, saveScheduleRules,
    loadLessonPlan, saveLessonPlan, assignLessonPlanItem,
    assignGenerationToPlan,
    updateKid, addSubjectToKid, deleteSubject, updateSubjectResources, uploadKidAvatar,
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
      <SetupFlow
        user={user}
        onSaveKid={saveKid}
        onUpdateKid={updateKid}
        onSaveSemesterPlan={saveSemesterPlan}
        onComplete={completeSetup}
      />
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
        onAssignGenerationToPlan={assignGenerationToPlan}
        onLoadSemesterPlanWeekFor={loadSemesterPlanWeekFor}
        onLoadSemesterPlanWeeksForKid={loadSemesterPlanWeeksForKid}
        onUpdateSemesterPlanWeek={updateSemesterPlanWeek}
        onLoadWeeklyCheckpoint={loadWeeklyCheckpoint}
        onSaveWeeklyCheckpoint={saveWeeklyCheckpoint}
        onUpdateKid={updateKid}
        onAddSubject={addSubjectToKid}
        onDeleteSubject={deleteSubject}
        onUpdateSubjectResources={updateSubjectResources}
        onUploadAvatar={uploadKidAvatar}
        onSignOut={signOut}
        onAddKid={saveKid}
      />
    </>
  );
}