-- =============================================================================
-- MosqAI Supabase / PostgreSQL Helper Queries
-- =============================================================================

-- 1. Insert a new sermon run into history
INSERT INTO mosq_session_history (
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
    'Oct 5, 2026',
    '11:45 PM',
    2100,
    '35m 0s',
    18,
    42,
    38,
    4,
    'ar',
    'en',
    'English',
    '[
      {
        "original": "إن الحمد لله نحمده ونستعينه ونستغفره",
        "translation": "All praise is due to Allah; we praise Him, seek His help, and ask for His forgiveness.",
        "timestamp": "2026-10-05T17:45:00.000Z"
      }
    ]'::jsonb
);

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
FROM mosq_session_history
WHERE session_id = 'myo-youth'
ORDER BY started_at DESC;

-- 3. Delete a specific history entry
DELETE FROM mosq_session_history
WHERE id = 'hist_myo-youth_example';

-- 4. Get overall attendance statistics across all sessions
SELECT 
    session_id,
    COUNT(*) as total_sermon_days,
    MAX(total_attendance) as peak_attendance_ever,
    AVG(total_attendance)::INTEGER as avg_attendance,
    SUM(total_transcripts) as total_speech_sentences
FROM mosq_session_history
GROUP BY session_id;
