-- =============================================================================
-- MosqAI Supabase / PostgreSQL Helper Queries
-- =============================================================================

-- 1. Insert a new sermon run into history (safe with ON CONFLICT)
INSERT INTO public.mosq_session_history (
    id,
    session_id,
    mosque_name,
    started_at,
    ended_at,
    date_display,
    time_display,
    duration_seconds,
    duration_display,
    total_transcripts,
    total_attendance,
    phone_attendees,
    computer_displays,
    speaker_language,
    tv_language,
    tv_language_name,
    transcripts
) VALUES (
    'hist_myo-youth_example',
    'myo-youth',
    'MYO Youth Center',
    NOW() - INTERVAL '35 minutes',
    NOW(),
    'Oct 6, 2026',
    '12:15 AM',
    2100,
    '35m 0s',
    18,
    42,
    38,
    4,
    'auto',
    'en',
    'English',
    '[
      {
        "original": "الحمد لله رب العالمين، والصلاة والسلام على رسوله الكريم",
        "translation": "All praise is due to Allah, Lord of the worlds, and peace and blessings upon His noble Messenger.",
        "timestamp": "2026-10-06T00:15:00.000Z"
      },
      {
        "original": "فإن مع العسر يسرا، إن مع العسر يسرا",
        "translation": "For indeed, with hardship will be ease. Indeed, with hardship will be ease.",
        "timestamp": "2026-10-06T00:16:00.000Z"
      }
    ]'::jsonb
) ON CONFLICT (id) DO UPDATE SET
    total_transcripts = EXCLUDED.total_transcripts,
    transcripts = EXCLUDED.transcripts;

-- 2. Fetch all historical runs for a specific session (newest first)
SELECT 
    id,
    session_id,
    mosque_name,
    started_at,
    ended_at,
    date_display,
    time_display,
    duration_display,
    total_transcripts,
    total_attendance,
    phone_attendees,
    computer_displays,
    speaker_language,
    tv_language,
    tv_language_name,
    transcripts
FROM public.mosq_session_history
WHERE session_id = 'myo-youth'
ORDER BY started_at DESC;

-- 3. Delete a specific history entry
DELETE FROM public.mosq_session_history
WHERE id = 'hist_myo-youth_example';

-- 4. Get overall attendance statistics across all sessions
SELECT 
    session_id,
    COUNT(*) as total_sermon_days,
    MAX(total_attendance) as peak_attendance_ever,
    AVG(total_attendance)::INTEGER as avg_attendance,
    SUM(total_transcripts) as total_speech_sentences
FROM public.mosq_session_history
GROUP BY session_id;
