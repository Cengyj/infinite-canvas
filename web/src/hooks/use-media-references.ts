import { useEffect, useLayoutEffect, useRef } from "react";

import { retainMediaReferences } from "@/services/media-references";

export function useMediaReferences(read: () => unknown) {
    const latest = useRef(read);
    useLayoutEffect(() => { latest.current = read; });
    useEffect(() => retainMediaReferences(() => latest.current()), []);
}
