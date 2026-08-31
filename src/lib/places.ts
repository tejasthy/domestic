'use server';

/**
 * Address autocomplete via Google Places Autocomplete (New).
 *
 * Called from a server action rather than loading the Maps JS SDK, which keeps
 * the API key server-side, avoids a third-party script on a page that is mostly
 * a form, and lets the dropdown use the app's own styling.
 *
 * Degrades to a plain text field when GOOGLE_MAPS_API_KEY is unset — an
 * optional convenience, never a hard dependency.
 */

export type AddressSuggestion = {
  id: string;
  /** "526 Detroit St, Ann Arbor, MI, USA" */
  text: string;
  /** "526 Detroit St" — the part worth bolding */
  main: string;
  secondary: string;
};

export async function searchAddresses(query: string): Promise<AddressSuggestion[]> {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return [];

  const trimmed = query.trim();
  if (trimmed.length < 3) return [];

  try {
    const res = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        // Ask for only the fields we render; billing is field-dependent.
        'X-Goog-FieldMask':
          'suggestions.placePrediction.placeId,suggestions.placePrediction.text,suggestions.placePrediction.structuredFormat',
      },
      body: JSON.stringify({
        input: trimmed,
        includedPrimaryTypes: ['street_address', 'premise', 'subpremise'],
      }),
      // Suggestions are not worth a slow page; give up rather than hang.
      signal: AbortSignal.timeout(4000),
    });

    if (!res.ok) {
      console.error('[places] lookup failed', res.status, await res.text().catch(() => ''));
      return [];
    }

    const json = (await res.json()) as {
      suggestions?: {
        placePrediction?: {
          placeId?: string;
          text?: { text?: string };
          structuredFormat?: { mainText?: { text?: string }; secondaryText?: { text?: string } };
        };
      }[];
    };

    return (json.suggestions ?? [])
      .map((s) => s.placePrediction)
      .filter((p): p is NonNullable<typeof p> => Boolean(p?.text?.text))
      .map((p) => ({
        id: p.placeId ?? p.text!.text!,
        text: p.text!.text!,
        main: p.structuredFormat?.mainText?.text ?? p.text!.text!,
        secondary: p.structuredFormat?.secondaryText?.text ?? '',
      }))
      .slice(0, 5);
  } catch (err) {
    // A timeout or network blip should never block someone creating a house.
    console.error('[places] lookup error', err);
    return [];
  }
}
