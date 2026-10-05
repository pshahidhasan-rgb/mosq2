-- =============================================================================
-- MosqAI Supabase / PostgreSQL Setup Script (Fixed & Production Ready)
-- =============================================================================
-- This script:
-- 1. Creates `public.mosq_sessions` table (with 'mosq_' prefix to prevent collisions)
-- 2. Creates `public.mosq_session_history` table for multi-day sermon records
-- 3. Creates performance indexes
-- 4. Enables RLS and safely applies policies (using DROP POLICY IF EXISTS)
-- 5. Grants permissions to Supabase roles (anon, authenticated, service_role)
-- 6. Seeds the default session ('myo-youth') so history queries work immediately
-- =============================================================================

-- Step 1: Create mosq_sessions table
CREATE TABLE IF NOT EXISTS public.mosq_sessions (
    id TEXT PRIMARY KEY,                       -- e.g. 'myo-youth', 'east-london'
    mosque_name TEXT NOT NULL,                -- e.g. 'MYO Youth Center'
    primary_language TEXT DEFAULT 'en',       -- Default primary language code ('en', 'ar', etc.)
    speaker_language TEXT DEFAULT 'auto',     -- Speaker input language ('auto', 'ar', 'en', etc.)
    tv_language TEXT DEFAULT 'en',            -- Current TV display language
    tv_font_size TEXT DEFAULT 'medium',       -- 'small', 'medium', 'large', 'xlarge'
    tv_capacity INTEGER DEFAULT 12,           -- Max lines displayed on TV (default 3X = 12)
    tv_audio_enabled BOOLEAN DEFAULT false,   -- Whether TV speech audio is enabled
    tv_show_qr BOOLEAN DEFAULT true,          -- Whether TV displays attendee QR code
    status TEXT DEFAULT 'idle',               -- 'idle', 'active', 'paused', 'ended'
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Step 2: Create mosq_session_history table
CREATE TABLE IF NOT EXISTS public.mosq_session_history (
    id TEXT PRIMARY KEY,                       -- e.g. 'hist_myo-youth_1790184000000'
    session_id TEXT NOT NULL,                  -- Links to mosq_sessions(id)
    mosque_name TEXT NOT NULL,                 -- Mosque name at time of delivery
    started_at TIMESTAMPTZ DEFAULT NOW(),      -- Khutbah start timestamp
    ended_at TIMESTAMPTZ,                     -- Khutbah end timestamp
    date_display TEXT NOT NULL,                -- e.g. 'Oct 6, 2026'
    time_display TEXT NOT NULL,                -- e.g. '12:15 AM'
    duration_seconds INTEGER DEFAULT 0,        -- Total sermon duration in seconds
    duration_display TEXT DEFAULT '0m 0s',     -- Human-readable duration
    total_transcripts INTEGER DEFAULT 0,       -- Number of speech sentences spoken
    total_ayahs_detected INTEGER DEFAULT 0,    -- Number of Quran verses identified
    total_attendance INTEGER DEFAULT 0,        -- Total connected browsers at peak
    phone_attendees INTEGER DEFAULT 0,         -- Mobile phones connected
    computer_displays INTEGER DEFAULT 0,       -- TV screens / computers connected
    speaker_language TEXT DEFAULT 'auto',      -- Language spoken by speaker
    tv_language TEXT DEFAULT 'en',             -- Display TV language during sermon
    tv_language_name TEXT DEFAULT 'English',   -- Full name of TV language
    transcripts JSONB DEFAULT '[]'::jsonb,     -- Array of { original, translation, timestamp }
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Step 3: Create Performance Indexes
CREATE INDEX IF NOT EXISTS idx_mosq_sessions_status 
    ON public.mosq_sessions(status);

CREATE INDEX IF NOT EXISTS idx_mosq_history_session_id 
    ON public.mosq_session_history(session_id);

CREATE INDEX IF NOT EXISTS idx_mosq_history_started_at 
    ON public.mosq_session_history(started_at DESC);

-- Step 4: Enable Row Level Security (RLS)
ALTER TABLE public.mosq_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mosq_session_history ENABLE ROW LEVEL SECURITY;

-- Step 5: Safe Policy Creation (PostgreSQL standard DROP IF EXISTS + CREATE)
DROP POLICY IF EXISTS "Allow all access to mosq_sessions" ON public.mosq_sessions;
CREATE POLICY "Allow all access to mosq_sessions" ON public.mosq_sessions
    FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow all access to mosq_session_history" ON public.mosq_session_history;
CREATE POLICY "Allow all access to mosq_session_history" ON public.mosq_session_history
    FOR ALL USING (true) WITH CHECK (true);

-- Step 6: Grant API Access Permissions (Required for Supabase REST / Client)
GRANT ALL ON TABLE public.mosq_sessions TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.mosq_session_history TO anon, authenticated, service_role;

-- Step 7: Seed Default Session (Ensures session exists for testing queries)
INSERT INTO public.mosq_sessions (
    id, mosque_name, primary_language, speaker_language, tv_language, status
) VALUES (
    'myo-youth', 'MYO Youth Center', 'en', 'auto', 'en', 'idle'
) ON CONFLICT (id) DO NOTHING;
