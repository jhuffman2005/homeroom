// src/hooks/useHomeRoom.js
// ─── Main data hook — all Supabase reads/writes for the app ──────────────────
import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';

export function useHomeRoom(userId) {
  const [kids, setKids]               = useState([]);
  const [semester, setSemester]       = useState(null);
  const [history, setHistory]         = useState([]);
  const [dataLoading, setDataLoading] = useState(true);
  const [setupDone, setSetupDone]     = useState(false);

  // ── Load all data on mount ──────────────────────────────────────────────────
  useEffect(() => {
    if (!userId) return;
    loadAll();
  }, [userId]);

  const loadAll = async () => {
    setDataLoading(true);
    try {
      await Promise.all([loadKids(), loadSemester(), loadHistory()]);
    } finally {
      setDataLoading(false);
    }
  };

  // ── Kids ───────────────────────────────────────────────────────────────────
  const loadKids = async () => {
    // Load kids with their subjects and curriculum weeks in one go
    const { data: kidsData, error } = await supabase
      .from('kids')
      .select(`
        id, name, grade, learning_style, emoji,
        subjects (
          id, name,
          curriculum_weeks ( week_number, topic, description )
        )
      `)
      .eq('user_id', userId)
      .order('created_at');

    if (error) { console.error('loadKids error:', error); return; }

    // Reshape into the format the UI expects
    const shaped = (kidsData || []).map(k => ({
      id: k.id,
      name: k.name,
      grade: k.grade,
      learningStyle: k.learning_style,
      emoji: k.emoji || '📚',
      // subjects as array of name strings (for UI display)
      subjects: (k.subjects || []).map(s => s.name),
      // curriculumWeeks: { "Saxon Math 7/6": [{week, topic, description}...] }
      curriculumWeeks: (k.subjects || []).reduce((acc, s) => {
        if (s.curriculum_weeks?.length) {
          acc[s.name] = s.curriculum_weeks
            .sort((a, b) => a.week_number - b.week_number)
            .map(w => ({ week: w.week_number, topic: w.topic, description: w.description }));
        }
        return acc;
      }, {}),
      // subjectIds: internal map for curriculum saves { "Saxon Math 7/6": uuid }
      _subjectIds: (k.subjects || []).reduce((acc, s) => { acc[s.name] = s.id; return acc; }, {})
    }));

    setKids(shaped);
    setSetupDone(shaped.length > 0);
    return shaped;
  };

  // Save a new kid + their subjects in one transaction
  const saveKid = async ({ name, grade, learningStyle, subjects, emoji = '📚' }) => {
    // 1. Insert kid
    const { data: kidRow, error: kidError } = await supabase
      .from('kids')
      .insert({ user_id: userId, name, grade, learning_style: learningStyle, emoji })
      .select()
      .single();
    if (kidError) throw kidError;

    // 2. Insert subjects
    const subjectRows = subjects
      .filter(s => s.trim())
      .map(s => ({ kid_id: kidRow.id, name: s.trim() }));

    if (subjectRows.length) {
      const { error: subError } = await supabase.from('subjects').insert(subjectRows);
      if (subError) throw subError;
    }

    // Reload to get full shaped structure
    await loadKids();
    return kidRow.id;
  };

  // ── Semester ───────────────────────────────────────────────────────────────
  const loadSemester = async () => {
    const { data, error } = await supabase
      .from('semesters')
      .select('*')
      .eq('user_id', userId)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (error && error.code !== 'PGRST116') {  // PGRST116 = no rows, not a real error
      console.error('loadSemester error:', error);
      return;
    }

    if (data) {
      setSemester({ start: data.start_date, end: data.end_date, id: data.id });
      setSetupDone(true);
    }
  };

  const saveSemester = async ({ start, end }) => {
    // Deactivate any existing active semesters
    await supabase
      .from('semesters')
      .update({ is_active: false })
      .eq('user_id', userId)
      .eq('is_active', true);

    const { data, error } = await supabase
      .from('semesters')
      .insert({ user_id: userId, start_date: start, end_date: end, is_active: true })
      .select()
      .single();
    if (error) throw error;

    setSemester({ start: data.start_date, end: data.end_date, id: data.id });
    return data;
  };

  // ── Curriculum Weeks ───────────────────────────────────────────────────────
  const saveCurriculumWeeks = async ({ kidId, subject, weeks }) => {
    // Find the subject_id from the loaded kids
    const kid = kids.find(k => k.id === kidId);
    if (!kid) throw new Error('Kid not found');

    let subjectId = kid._subjectIds?.[subject];

    // If subject doesn't have an ID yet (edge case), create it
    if (!subjectId) {
      const { data: subRow, error } = await supabase
        .from('subjects')
        .insert({ kid_id: kidId, name: subject })
        .select()
        .single();
      if (error) throw error;
      subjectId = subRow.id;
    }

    // Delete existing weeks for this subject, then re-insert
    await supabase.from('curriculum_weeks').delete().eq('subject_id', subjectId);

    const rows = weeks.map(w => ({
      subject_id: subjectId,
      week_number: w.week,
      topic: w.topic,
      description: w.description || null
    }));

    const { error } = await supabase.from('curriculum_weeks').insert(rows);
    if (error) throw error;

    // Reload kids to update UI
    await loadKids();
  };

  // ── Generation History ─────────────────────────────────────────────────────
  const loadHistory = async () => {
    const { data, error } = await supabase
      .from('generations')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(200);

    if (error) { console.error('loadHistory error:', error); return; }

    const shaped = (data || []).map(row => ({
      id: row.id,
      toolId: row.tool_id,
      toolTitle: row.tool_title,
      toolIcon: row.tool_icon,
      kidId: row.kid_id,
      kidName: row.kid_name,
      subject: row.subject_name,
      topic: row.topic,
      content: row.content,
      createdAt: row.created_at
    }));

    setHistory(shaped);
  };

  const saveGeneration = async (entry) => {
    const { data, error } = await supabase
      .from('generations')
      .insert({
        user_id: userId,
        kid_id: entry.kidId || null,
        kid_name: entry.kidName,
        subject_name: entry.subject,
        tool_id: entry.toolId,
        tool_title: entry.toolTitle,
        tool_icon: entry.toolIcon,
        topic: entry.topic,
        content: entry.content
      })
      .select()
      .single();
    if (error) throw error;

    // Optimistically prepend to local history
    setHistory(prev => [{
      ...entry,
      id: data.id,
      createdAt: data.created_at
    }, ...prev]);

    return data;
  };

  const deleteGeneration = async (id) => {
    const { error } = await supabase.from('generations').delete().eq('id', id);
    if (error) throw error;
    setHistory(prev => prev.filter(h => h.id !== id));
  };

  // ── Complete setup flow ────────────────────────────────────────────────────
  const completeSetup = async ({ kids: newKids, semesterDates }) => {
    // Save all kids
    for (const kid of newKids) {
      await saveKid(kid);
    }
    // Save semester
    await saveSemester(semesterDates);
    setSetupDone(true);
  };

  return {
    kids, semester, history, dataLoading, setupDone,
    saveKid, saveSemester, saveCurriculumWeeks,
    saveGeneration, deleteGeneration,
    completeSetup, reload: loadAll
  };
}
