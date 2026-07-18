import { SynthesisSearchResponse, SynthesisStatus } from "@/types";
import { invoke } from "@tauri-apps/api";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

export type SynthesisForm = {
  /** Trait ids as 8-hex strings (the `traits:` bundle key space), or null. */
  trait1: string | null;
  trait2: string | null;
  anyOrder: boolean;
  requireLucky: boolean;
};

export type SynthesisQueryPayload = {
  trait1: number;
  trait2: number | null;
  anyOrder: boolean;
  requireLucky: boolean;
};

/** Form -> backend query; null when the form is incomplete (no first trait). */
export const buildQuery = (form: SynthesisForm): SynthesisQueryPayload | null => {
  if (!form.trait1) return null;
  return {
    trait1: parseInt(form.trait1, 16),
    trait2: form.trait2 ? parseInt(form.trait2, 16) : null,
    anyOrder: form.anyOrder,
    requireLucky: form.requireLucky,
  };
};

/**
 * State + handlers for the Synthesis Helper tool: a trait-pair query form,
 * the live game status, and the search results.
 */
export default function useSynthesisHelper() {
  // Re-render when the traits bundle loads / language changes (same pattern
  // as useChecklistSettings).
  const { i18n } = useTranslation("traits");
  const [form, setForm] = useState<SynthesisForm>({
    trait1: null,
    trait2: null,
    anyOrder: false,
    requireLucky: false,
  });
  const [status, setStatus] = useState<SynthesisStatus | null>(null);
  const [response, setResponse] = useState<SynthesisSearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    invoke<SynthesisStatus>("fetch_synthesis_status")
      .then(setStatus)
      .catch((e) => setError(String(e)));
  }, []);

  const traitOptions = (): { value: string; label: string }[] => {
    const bundle = (i18n.getResourceBundle(i18n.language, "traits") ??
      i18n.getResourceBundle("en", "traits") ??
      {}) as Record<string, { text?: string }>;
    return Object.entries(bundle)
      .filter(([, value]) => Boolean(value?.text))
      .map(([hex, value]) => ({ value: hex, label: value.text as string }))
      .sort((a, b) => a.label.localeCompare(b.label));
  };

  const search = async () => {
    const query = buildQuery(form);
    if (!query) return;
    setSearching(true);
    setError(null);
    try {
      setResponse(await invoke<SynthesisSearchResponse>("search_synthesis", { query }));
    } catch (e) {
      setResponse(null);
      setError(String(e));
    } finally {
      setSearching(false);
    }
  };

  return { form, setForm, status, response, error, searching, traitOptions, search };
}
