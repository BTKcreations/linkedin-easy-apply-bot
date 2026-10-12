// Copy this file to profile.js and fill in YOUR facts:
//   cp profile.example.js profile.js   (Windows: copy profile.example.js profile.js)
// profile.js is gitignored — your personal data never leaves your machine.
// The bot may ONLY answer application questions from facts listed here.
export const PROFILE = {
  name: "Your Full Name",
  email: "you@example.com",
  phoneCountry: "India (+91)", // e.g. "United States (+1)"
  phone: "9876543210",
  location: "City, Country", // e.g. "Hyderabad, India"
  remote: true,
  remoteEquipped: true, // own device + internet for WFH? true/false
  languages: ["English"], // languages you speak — Hindi-type questions resolve from this
  cloud: ["AWS"], // cloud platforms you have hands-on experience with (empty array if none)
  productionApi: true, // shipped third-party API integrations to deployed apps? true/false
  education: { degree: "B.Tech AI & ML", college: "Your College", cgpa: "8.05", graduated: "May 2026" },
  degreeCompleted: true, // degree finished? true/false
  internshipMonths: 12, // professional experience for "how many years" questions
  github: "https://github.com/yourhandle",
  linkedin: "https://www.linkedin.com/in/yourhandle",
  authorizedIndia: true, // legally authorized to work in your country? (used as India default; adapt text)
  needSponsorship: false, // require visa sponsorship? true/false
  primaryLanguage: "Python", // your strongest language (drives "prefer X or Y" questions)
  skills: ["Python", "React", "Node.js"], // every tool/library you have HANDS-ON evidence for — SDK answers from this
  highlights: [
    "One line per proof: what you built with which tech, deployed where",
  ],
  // Pre-approved screening answers. ONLY add answers that are true for you —
  // the bot fills these deterministically; anything else escalates to AI/human.
  screening: {
    residingHyderabad: "Yes", // "Are you currently residing in <city>?"
    willingAmeerpetOnsite: "Yes", // on-site willingness for your city
    canStartImmediately: "Yes",
    hasBachelorsDegree: "Yes",
    joiningDays: "0", // "How soon can you join (days)?" — 0 = immediate
    expectedCtcLakhs: "7", // "Expected CTC (in Lakhs)" — YOUR number, never guessed
    currentCtcLakhs: "3", // "Current CTC (in Lakhs)"
    totalExperienceYears: "1", // professional years, document-backed
  },
  resumeFiles: [
    "C:/path/to/Your_Resume.pdf", // absolute path to the PDF submitted with applications
  ],
};

// Search configs. Keywords should mirror your resume.
export const SEARCHES = [
  { keywords: "AI Engineer", location: "Hyderabad, Telangana, India", filters: "f_AL=true&f_E=2&f_WT=1,2,3&sortBy=DD", maxApply: 5 },
  { keywords: "Full Stack Engineer", location: "Hyderabad, Telangana, India", filters: "f_AL=true&f_E=2&f_WT=1,2,3&sortBy=DD", maxApply: 5 },
];

// f_AL=true → Easy Apply only. f_E=2 → Entry level. f_WT=1,2,3 → On-site, Remote, Hybrid.

// Company bar: only top/mid/popular employers (followers on their LinkedIn page).
export const VERIFY = { minFollowers: 1000, topTier: 20000, midTier: 2000 };

// Skip rules — deterministic, no AI needed.
export const SKIP = {
  irrelevantTitles: [/CNC|Computer Numerical|Trainer|Manager|Principal|Staff|Senior(?!.*Associate)/i],
  seniorSignals: [/senior-level|mentor engineers|own .* strategy|5\+ years|8\+ years/i],
};
