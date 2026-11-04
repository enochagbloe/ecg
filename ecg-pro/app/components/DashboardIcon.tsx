const paths = {
  bolt: "m13 2-8 11h6l-1 9L20 9h-7l1-7Z",
  sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0-6v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5",
  meter: "M4 20V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v15H4Zm4-13h8v5H8V7Zm1 9h.01M15 16h.01",
  peak: "M3 17 9 11l4 4L21 5m-6 0h6v6",
  refresh: "M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-2l2 3M4 16l2 3a7 7 0 0 0 12-2",
  chart: "M4 4v16h17M8 15V9m5 6V5m5 10v-7",
  settings: "M4 7h16M4 17h16M8 4v6m8 4v6",
  signal: "M3 12h4l3-7 4 14 3-7h4",
} as const;

export function DashboardIcon({ name }: { name: keyof typeof paths }) {
  return <svg className="dashboard-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
