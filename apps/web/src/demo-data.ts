export const orbits = [
  {
    id: "glassworks",
    name: "Glassworks",
    letter: "G",
    slot: 1,
    badge: 7,
    context: "Production, purchasing, and operations for the glassworks.",
    sources: ["Google Workspace", "Slack", "Google Calendar"],
  },
  {
    id: "consulting",
    name: "Consulting",
    letter: "C",
    slot: 2,
    badge: 3,
    context: "Client networks, support, and project delivery.",
    sources: ["Microsoft 365", "Teams", "Outlook Calendar"],
  },
  {
    id: "campaigns",
    name: "Campaigns",
    letter: "M",
    slot: 3,
    badge: 3,
    context: "Client campaigns, email programs, and signup forms.",
    sources: ["Google Workspace", "Slack", "Google Calendar"],
  },
  {
    id: "personal",
    name: "Personal",
    letter: "P",
    slot: 4,
    badge: 1,
    context: "Home and anything not assigned to another Orbit.",
    sources: ["IMAP", "CalDAV"],
  },
] as const;
export type OrbitId = (typeof orbits)[number]["id"];
export const events: {
  orbit: OrbitId;
  title: string;
  start: number;
  end: number;
}[] = [
  { orbit: "glassworks", title: "Production standup", start: 9, end: 9.5 },
  {
    orbit: "consulting",
    title: "Client network review",
    start: 10.5,
    end: 11.5,
  },
  { orbit: "campaigns", title: "Campaign check-in", start: 11, end: 11.5 },
  {
    orbit: "glassworks",
    title: "Vendor call: batch materials",
    start: 13,
    end: 14,
  },
  { orbit: "campaigns", title: "Email program sync", start: 15, end: 15.5 },
  { orbit: "personal", title: "Hold: errands", start: 16.5, end: 17 },
];
export const needs: {
  orbit: OrbitId;
  who: string;
  via: string;
  age: string;
  what: string;
  why: string;
  urgent?: boolean;
}[] = [
  {
    orbit: "consulting",
    who: "Northgate Clinic",
    via: "Teams",
    age: "1h",
    urgent: true,
    what: "Asked for the revised SOW with the added switch.",
    why: "You meet with them at 10:30, and it hasn't been sent.",
  },
  {
    orbit: "glassworks",
    who: "Dana Reyes",
    via: "Email",
    age: "4d",
    what: "Wants to lock the kiln repair window for the week of November 2.",
    why: "Unanswered since Thursday. The repair crew is waiting on you to schedule.",
  },
  {
    orbit: "glassworks",
    who: "Riverside Silica",
    via: "Email",
    age: "3d",
    what: "Sent November pricing. Old price holds on orders placed before October 31.",
    why: "Affects the batch materials quote due Wednesday.",
  },
  {
    orbit: "consulting",
    who: "Priya Shah",
    via: "Email",
    age: "20m",
    what: "Has a question about VLAN 30 on the diagram you sent this morning.",
    why: "She's in your 10:30 meeting. A quick answer now saves time on the call.",
  },
];
export const proposals: {
  id: number;
  orbit: OrbitId;
  title: string;
  source: string;
}[] = [
  {
    id: 101,
    orbit: "glassworks",
    title: "Reply to Dana Reyes about the kiln repair schedule",
    source: "From email, Oct 16. Clears when you reply to Dana.",
  },
  {
    id: 102,
    orbit: "consulting",
    title: "Send updated SOW to Northgate Clinic",
    source: "From Teams chat, today 8:12 am. Clears when the SOW is sent.",
  },
  {
    id: 103,
    orbit: "campaigns",
    title: "Schedule a debrief with the campaign manager",
    source: "From a Slack thread, yesterday. Clears when a meeting is booked.",
  },
];
export const promises = {
  mine: [
    [
      "Send second switch pricing to Northgate",
      "Promised Oct 5 in a meeting. 14 days ago.",
    ],
    [
      "Share warmup stats with the campaign team",
      "You said Tuesday in Slack. Due tomorrow.",
    ],
    [
      "Confirm quarterly volume with Riverside Silica",
      "You said by October 31. 12 days left.",
    ],
  ],
  theirs: [
    [
      "Jordan Pike: September reconciliation",
      "You asked 6 days ago. No reply.",
    ],
    ["Northgate: signed change order", "You asked 9 days ago. No reply."],
  ],
};
export const cleared = [
  {
    id: 201,
    orbit: "glassworks" as OrbitId,
    title: "Reply to Tom Hale about pallet pickup",
    why: "Cleared by your Slack DM to Tom, 9:02 am",
  },
  {
    id: 202,
    orbit: "consulting" as OrbitId,
    title: "Send network diagram to Priya Shah",
    why: "Cleared by your email with the attachment, 8:47 am",
  },
];
export const tasks: {
  id: number;
  title: string;
  orbit: OrbitId;
  day: number | null;
  due: number | null;
  tag: string;
}[] = [
  {
    id: 1,
    title: "Draft batch materials quote request",
    orbit: "glassworks",
    day: 1,
    due: 3,
    tag: "purchasing",
  },
  {
    id: 2,
    title: "Approve October vendor invoices",
    orbit: "glassworks",
    day: 2,
    due: 4,
    tag: "finance",
  },
  {
    id: 3,
    title: "Replace AP in east warehouse",
    orbit: "glassworks",
    day: 4,
    due: null,
    tag: "IT",
  },
  {
    id: 4,
    title: "Send firewall change summary to client",
    orbit: "consulting",
    day: 1,
    due: 1,
    tag: "IT",
  },
  {
    id: 5,
    title: "Invoice October retainer",
    orbit: "consulting",
    day: 5,
    due: 5,
    tag: "finance",
  },
  {
    id: 6,
    title: "Review warmup stats",
    orbit: "campaigns",
    day: 2,
    due: null,
    tag: "marketing",
  },
  {
    id: 7,
    title: "Update signup form copy",
    orbit: "campaigns",
    day: 3,
    due: 4,
    tag: "marketing",
  },
  {
    id: 8,
    title: "Board report: Q3 numbers",
    orbit: "glassworks",
    day: null,
    due: 6,
    tag: "finance",
  },
  {
    id: 9,
    title: "Renew vehicle registration",
    orbit: "personal",
    day: null,
    due: 6,
    tag: "admin",
  },
  {
    id: 10,
    title: "Weekly backup check",
    orbit: "personal",
    day: 0,
    due: null,
    tag: "IT",
  },
];
export const inbox: Record<
  OrbitId,
  {
    from: string;
    via: string;
    subject: string;
    snippet: string;
    when: string;
  }[]
> = {
  glassworks: [
    {
      from: "Dana Reyes",
      via: "Email",
      subject: "Kiln repair window",
      snippet: "Can we lock the week of the 2nd? The crew needs a date.",
      when: "Thu",
    },
    {
      from: "Riverside Silica",
      via: "Email",
      subject: "Updated rate sheet",
      snippet: "Attached is the November pricing we discussed.",
      when: "Fri",
    },
    {
      from: "#purchasing",
      via: "Slack",
      subject: "Cullet delivery moved",
      snippet: "Truck is now Wednesday afternoon, not morning.",
      when: "8:31",
    },
  ],
  consulting: [
    {
      from: "Northgate Clinic",
      via: "Teams",
      subject: "SOW revision",
      snippet: "Can you send the version with the added switch?",
      when: "8:12",
    },
    {
      from: "Priya Shah",
      via: "Email",
      subject: "Network diagram",
      snippet: "One question on VLAN 30.",
      when: "9:20",
    },
  ],
  campaigns: [
    {
      from: "#email-program",
      via: "Slack",
      subject: "Warmup day 14",
      snippet: "Open rates are above target.",
      when: "Sun",
    },
  ],
  personal: [
    {
      from: "County DMV",
      via: "Email",
      subject: "Registration renewal",
      snippet: "Your registration expires at the end of the month.",
      when: "Wed",
    },
  ],
};
