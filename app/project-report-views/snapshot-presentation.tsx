"use client";
import {createContext, useContext, type ReactNode} from "react";
const SnapshotPresentation = createContext(false);
export function SnapshotPresentationProvider({children}: {children: ReactNode}) {
  return <SnapshotPresentation.Provider value={true}>{children}</SnapshotPresentation.Provider>;
}
export function useSnapshotPresentation() { return useContext(SnapshotPresentation); }
