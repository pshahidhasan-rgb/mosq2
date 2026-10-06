-- =============================================================================
-- MosqAI Database Schema for Supabase / PostgreSQL
-- =============================================================================
-- All tables are prefixed with 'mosq_' to guarantee zero naming collision
-- with any existing tables in your Supabase project.
-- Safe to run multiple times: uses IF NOT EXISTS throughout.
-- =============================================================================

-- 1. Mosque Sessions Table
CREATE TABLE IF NOT EXISTS public.mosq_sessions (
    id TEXT PRIMARY KEY,                       -- e.g. 'myo-youth', 'east-london'
    mosque_name TEXT NOT NULL,                -- e.g. 'MYO Youth Center'
    primary_language TEXT DEFAULT 'en',       -- Default primary language code ('en', 'ar', etc.)
    tv_language TEXT DEFAULT 'en',            -- Display TV target translation language
    tv_font_size TEXT DEFAULT 'medium',       -- 'small', 'medium', 'large', 'xlarge'
    tv_capacity INTEGER DEFAULT 12,           -- Max speech lines displayed on TV (default 3X = 12)
    tv_audio_enabled BOOLEAN DEFAULT false,   -- Whether TV speech audio is enabled
    tv_show_qr BOOLEAN DEFAULT true,          -- Whether TV displays attendee QR code
    status TEXT DEFAULT 'idle',               -- 'idle', 'active', 'paused', 'ended'
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast lookup by status
CREATE INDEX IF NOT EXISTS idx_mosq_sessions_status ON public.mosq_sessions(status);

-- 2. Mosque Session History (Daily Khutbah Runs)
-- Each record represents one sermon run/day for a session
CREATE TABLE IF NOT EXISTS public.mosq_session_history (
    id TEXT PRIMARY KEY,                       -- e.g. 'hist_myo-youth_1790184000000'
    session_id TEXT NOT NULL,                  -- Foreign reference to mosq_sessions(id)
    mosque_name TEXT NOT NULL,                 -- Mosque name at time of delivery
    started_at TIMESTAMPTZ,                   -- Khutbah start timestamp
    ended_at TIMESTAMPTZ,                     -- Khutbah end timestamp
    date_display TEXT NOT NULL,                -- e.g. 'Oct 6, 2026'
    time_display TEXT NOT NULL,                -- e.g. '11:45 PM'
    duration_seconds INTEGER DEFAULT 0,        -- Total sermon duration in seconds
    duration_display TEXT DEFAULT '0m 0s',     -- Human-readable duration
    total_transcripts INTEGER DEFAULT 0,       -- Number of speech sentences spoken
    total_attendance INTEGER DEFAULT 0,        -- Total connected browsers at peak
    phone_attendees INTEGER DEFAULT 0,         -- Mobile phones connected
    computer_displays INTEGER DEFAULT 0,       -- TV screens / computers connected
    tv_language TEXT DEFAULT 'en',             -- Display TV language during sermon
    tv_language_name TEXT DEFAULT 'English',   -- Full name of TV language
    transcripts JSONB DEFAULT '[]'::jsonb,     -- Array of { original, translation, timestamp }
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Fast lookup indexes
CREATE INDEX IF NOT EXISTS idx_mosq_history_session_id ON public.mosq_session_history(session_id);
CREATE INDEX IF NOT EXISTS idx_mosq_history_started_at ON public.mosq_session_history(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_mosq_history_created_at ON public.mosq_session_history(created_at DESC);

-- Enable Row Level Security (RLS) safely:
ALTER TABLE public.mosq_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mosq_session_history ENABLE ROW LEVEL SECURITY;

-- Allow public read & write access for API operations (PostgreSQL safe syntax)
DROP POLICY IF EXISTS "Allow all access to mosq_sessions" ON public.mosq_sessions;
CREATE POLICY "Allow all access to mosq_sessions" ON public.mosq_sessions
    FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow all access to mosq_session_history" ON public.mosq_session_history;
CREATE POLICY "Allow all access to mosq_session_history" ON public.mosq_session_history
    FOR ALL USING (true) WITH CHECK (true);

-- Grant API Access Permissions (Required for Supabase REST / PostgREST)
GRANT ALL ON TABLE public.mosq_sessions TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.mosq_session_history TO anon, authenticated, service_role;

-- Seed default session
INSERT INTO public.mosq_sessions (
    id, mosque_name, primary_language, tv_language, status
) VALUES (
    'myo-youth', 'MYO Youth Center', 'en', 'en', 'idle'
) ON CONFLICT (id) DO NOTHING;
