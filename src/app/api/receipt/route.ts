import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getProvider, ScanError } from '@/lib/ai';
import type { AiProvider } from '@/lib/types';

export const maxDuration = 60;

const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
type Accepted = (typeof ACCEPTED)[number];

/** Roughly a vision model's 5 MB per-image ceiling, checked before we spend a call. */
const MAX_BYTES = 4.5 * 1024 * 1024;

export async function POST(request: NextRequest) {
  // Auth first — vision calls cost money, so no unauthenticated access.
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
  }

  const secret = process.env.AI_CONFIG_ENCRYPTION_KEY;
  const { data: creds } = secret
    ? await supabase.rpc('get_ai_credentials', { p_secret: secret })
    : { data: null };
  const cred = Array.isArray(creds) ? creds[0] : null;

  if (!secret || !cred?.api_key) {
    return NextResponse.json(
      {
        error:
          'Receipt scanning is not configured. Ask an admin to add an AI provider key in Settings → Household.',
      },
      { status: 503 },
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Expected a multipart upload.' }, { status: 400 });
  }

  const file = form.get('image');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'No image attached.' }, { status: 400 });
  }
  if (!ACCEPTED.includes(file.type as Accepted)) {
    return NextResponse.json(
      {
        error:
          file.type === 'image/heic' || file.type === 'image/heif'
            ? 'HEIC photos are not supported — the app converts to JPEG before upload, so try re-taking the photo.'
            : `Unsupported image type: ${file.type || 'unknown'}.`,
      },
      { status: 415 },
    );
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: 'That image is too large. Try again — the app downscales before upload.' },
      { status: 413 },
    );
  }

  const data = Buffer.from(await file.arrayBuffer()).toString('base64');
  const provider = getProvider(cred.provider as AiProvider, cred.api_key);

  try {
    const parsed = await provider.scanReceipt({ imageBase64: data, mediaType: file.type });
    if (!parsed) {
      return NextResponse.json(
        { error: "Couldn't read that one. Enter it by hand?" },
        { status: 422 },
      );
    }
    return NextResponse.json({ receipt: parsed });
  } catch (err) {
    if (err instanceof ScanError) {
      const status = err.kind === 'rate_limit' ? 429 : 502;
      return NextResponse.json({ error: err.message }, { status });
    }
    console.error('[receipt] unexpected', err);
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
  }
}
