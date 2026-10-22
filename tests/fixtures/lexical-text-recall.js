// Labels express the scenario's expected answer, independently of search code.
export const lexicalRecallFixture = {
  question: "What was the Orion rollback procedure?",
  answer: {
    content: "Orion rollback requires disabling the canary gate before restoring release 17; verify the checksum before enabling traffic.",
    keywords: ["Orion", "Rollback", "Procedure"],
    type: "procedure",
    importance: 0.3,
    ageDays: 180
  },
  distractor: {
    content: "Orion dashboard color preference is green.",
    keywords: ["orion", "dashboard"],
    type: "preference",
    importance: 0.9,
    ageDays: 1
  },
  unindexed: {
    content: "Zephyr evacuation instructions exist only in this sentence, not in the stored keyword index.",
    keywords: ["operations"],
    type: "fact",
    importance: 0.7,
    ageDays: 1
  },
  obsolete: {
    content: "Orion recovery rollback used release 16 before the checksum correction.",
    keywords: ["orion", "recovery", "rollback"],
    type: "procedure",
    importance: 0.6,
    ageDays: 210
  },
  correction: {
    content: "Correction: Orion recovery rollback must restore release 17; release 16 has an invalid checksum.",
    keywords: ["orion", "recovery", "rollback"],
    type: "procedure",
    importance: 0.6,
    ageDays: 180
  }
};
