const props = {
  width: 22,
  height: 22,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

export const ListIcon = () => (
  <svg {...props}>
    <path d="M9 6h11M9 12h11M9 18h11" />
    <circle cx="4.5" cy="6" r="1" />
    <circle cx="4.5" cy="12" r="1" />
    <circle cx="4.5" cy="18" r="1" />
  </svg>
);

export const StackIcon = () => (
  <svg {...props}>
    <rect x="3" y="4" width="18" height="5" rx="1.5" />
    <rect x="5" y="11" width="14" height="4" rx="1.5" />
    <rect x="7" y="17" width="10" height="3" rx="1.5" />
  </svg>
);

export const CalendarIcon = () => (
  <svg {...props}>
    <rect x="3" y="5" width="18" height="16" rx="2" />
    <path d="M3 10h18M8 3v4M16 3v4" />
  </svg>
);

export const GripIcon = () => (
  <svg {...props} width={18} height={18}>
    <circle cx="9" cy="6" r="1" />
    <circle cx="15" cy="6" r="1" />
    <circle cx="9" cy="12" r="1" />
    <circle cx="15" cy="12" r="1" />
    <circle cx="9" cy="18" r="1" />
    <circle cx="15" cy="18" r="1" />
  </svg>
);

export const XIcon = () => (
  <svg {...props} width={18} height={18}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

export const ChevronLeft = () => (
  <svg {...props}>
    <path d="M15 18l-6-6 6-6" />
  </svg>
);

export const ChevronRight = () => (
  <svg {...props}>
    <path d="M9 18l6-6-6-6" />
  </svg>
);

export const TimerIcon = () => (
  <svg {...props}>
    <circle cx="12" cy="13" r="8" />
    <path d="M12 9v4l2.5 2.5M9.5 2h5" />
  </svg>
);
