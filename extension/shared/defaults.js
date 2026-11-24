// Settings defaults shared by the background worker and any other Earshot host.
(function (root) {
  const Earshot = (root.Earshot = root.Earshot || {});

  Earshot.DEFAULTS = {
    autoCaptions: true,
    redirectZoom: true,
    captionLanguage: "en",
    panelMode: "docked",
    panelOpenOnJoin: false, // a new meeting shows only the launcher; the panel opens from it
    autoMinutes: true,
    notifyEnded: true, // "meeting saved" notification shortly after a meeting ends; click opens it
    endedNoticeSeconds: 30, // how long after the end; a refresh or rejoin within it sends none
    minutesDelayMinutes: 5, // after a meeting ends, wait this long before writing minutes and filing
    captionsOffSeconds: 60, // no captions this long after joining: warn that the host has them off
    captionsLostSeconds: 120, // captions silent this long mid-meeting: warn that they stopped
    // Example tags: replace these with your own clients, teams or projects (Settings in the app,
    // or edit this list). A meeting title that names a tag or one of its aliases gets that tag.
    tags: ["Acme", "Globex", "Initech", "Hiring", "Internal", "Vendor", "Personal"],
    // Extra words in a meeting title that mean a tag (the tag's own name always counts).
    // Your own aliases (Settings) are added to these, not swapped in.
    tagAliases: {
      Acme: ["Acme Corp", "ACME"],
      Globex: ["Globex Corporation"],
      Initech: ["Init Tech", "Initech Labs"],
      Hiring: ["Interview", "Candidate", "Phone screen"],
      Internal: ["Team sync", "Standup", "All hands", "1:1"],
    },
    // Vendors a title can name; words that are also everyday words are best left out.
    vendors: ["Notion", "Linear", "Slack", "Figma", "Stripe"],
    theme: "dark", // or "light"
  }
})(typeof self !== "undefined" ? self : globalThis);
