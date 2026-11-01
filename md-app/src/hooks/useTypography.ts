import { useEffect, useState } from "react";
import {
  applyTypography,
  loadTypography,
  saveTypography,
  type TypographySettings,
} from "@/lib/typography";

/* One source of truth for typography: the initial read happens before the
   first render (main.tsx) so there is no font flash; this hook keeps the
   document root and localStorage in sync with React state afterwards. */
export function useTypography() {
  const [typography, setTypography] = useState<TypographySettings>(loadTypography);

  useEffect(() => {
    applyTypography(typography);
    saveTypography(typography);
  }, [typography]);

  return [typography, setTypography] as const;
}
