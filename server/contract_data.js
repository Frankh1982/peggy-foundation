export const NEWS_TOPICS = [
  {
    topic_key: "us/china/tariffs",
    title: "US–China tariffs",
    aliases: [
      /china\s+tariffs?/i,
      /tariff\s+review/i,
      /section\s+301/i
    ],
    searchQuery: "US China tariffs review 2025",
    summary: "Washington is keeping Section 301 duties on strategic Chinese imports in place while it reopens a narrow relief process for manufacturers.",
    updates: [
      {
        text: "USTR confirmed the 25% rate on advanced Chinese tech goods will stay while it solicits requests for temporary exclusions to protect EV and battery supply chains.",
        source: 0
      },
      {
        text: "Industry groups said they will file comments before the 2025-03-01 window closes, pressing for relief on components that face dual tariffs.",
        source: 1
      }
    ],
    watch: "Watch for the March Section 301 review update and whether semiconductor tools receive targeted exemptions.",
    sources: [
      {
        title: "Reuters",
        url: "https://example.com/reuters-us-china-tariffs",
        date: "2025-02-11"
      },
      {
        title: "Bloomberg",
        url: "https://example.com/bloomberg-tariffs-review",
        date: "2025-02-10"
      }
    ],
    facts: [
      {
        claim: "USTR is keeping the 25% Section 301 tariff on strategic Chinese technology imports while reopening a narrow exclusion process.",
        evidence: "Reuters reported that USTR left the 25% rate intact but invited companies to request targeted relief to protect EV and battery supply chains.",
        source_indices: [0],
        tags: ["news", "trade", "tariffs"],
        facets: ["trade", "tariffs"],
        confidence: 0.72
      },
      {
        claim: "Business coalitions plan to submit Section 301 tariff comments before the 2025-03-01 deadline to argue for relief on dual-tariff components.",
        evidence: "Bloomberg noted that manufacturing groups intend to file feedback in February ahead of the March deadline to secure relief on inputs facing tariffs in both the U.S. and China.",
        source_indices: [1],
        tags: ["news", "trade", "policy"],
        facets: ["policy", "timeline"],
        confidence: 0.68
      }
    ]
  },
  {
    topic_key: "byd/india/factory/plans",
    title: "BYD India factory plans",
    aliases: [
      /byd\s+india/i,
      /indian\s+ev\s+plant/i,
      /byd\s+factory\s+plans?/i
    ],
    searchQuery: "BYD India EV factory joint venture",
    summary: "BYD and Megha Engineering are advancing a joint venture plan for an Indian EV assembly plant while awaiting the government's revised import policy.",
    updates: [
      {
        text: "Local partners told business press the JV has short-listed sites near Hyderabad and Chennai to stage CKD assembly once approvals arrive.",
        source: 0
      },
      {
        text: "Officials signaled New Delhi's new EV import rules could clear by late February, shaping BYD's timeline for shipping kits from China.",
        source: 1
      }
    ],
    watch: "Watch for New Delhi's EV import framework and state incentives that would greenlight BYD's construction start in 2025.",
    sources: [
      {
        title: "Economic Times",
        url: "https://example.com/economic-times-byd-india",
        date: "2025-02-12"
      },
      {
        title: "Mint",
        url: "https://example.com/mint-ev-policy",
        date: "2025-02-11"
      }
    ],
    facts: [
      {
        claim: "BYD and Megha Engineering have short-listed sites near Hyderabad and Chennai for their planned CKD EV assembly venture in India.",
        evidence: "Economic Times reported the partners are evaluating Telangana and Tamil Nadu industrial zones to launch the joint project once permits land.",
        source_indices: [0],
        tags: ["news", "ev", "india"],
        facets: ["ev", "manufacturing"],
        confidence: 0.7
      },
      {
        claim: "India's forthcoming EV import rules, expected in late February, will determine when BYD can begin shipping kits for the JV plant.",
        evidence: "Mint wrote that policy guidance due within weeks will dictate duties on imported EV kits, affecting BYD's 2025 launch schedule.",
        source_indices: [1],
        tags: ["news", "policy", "india"],
        facets: ["policy", "timeline"],
        confidence: 0.69
      }
    ]
  }
];

export const RECIPE_LIBRARY = [
  {
    topic_key: "cooking/apple-pie",
    aliases: [/apple\s+pie/i, /classic\s+apple\s+pie/i],
    title: "Classic Apple Pie",
    ingredients: [
      "1.2 kg tart apples, peeled and sliced",
      "90 g granulated sugar",
      "45 g light brown sugar",
      "6 g ground cinnamon",
      "2 g freshly grated nutmeg",
      "30 g cornstarch",
      "4 g fine sea salt",
      "30 mL lemon juice",
      "60 g unsalted butter, diced",
      "400 g all-butter pie dough (two 23 cm rounds)"
    ],
    steps: [
      "Heat the oven to 190°C (375°F). Toss the apples with both sugars, spices, salt, lemon juice, and cornstarch until evenly coated.",
      "Line a 23 cm pie tin with one dough round. Fill with the apple mixture, mound slightly, and dot the top with the diced butter.",
      "Cover with the second dough round, crimp, cut vents, then chill the assembled pie for 15 minutes.",
      "Bake on the middle rack for 50–55 minutes until the juices bubble and the crust is deep golden. Cool at least 2 hours before slicing."
    ],
    variants: [
      "Swap 50 g of the sugar for maple syrup and add 50 g chopped pecans for a maple-pecan riff.",
      "Use a cheddar cheese crust and stir 5 g of sharp cheddar into the filling for a savory-sweet twist."
    ],
    facets: ["dessert", "baking"],
    fact: {
      claim: "Classic apple pie uses 1.2 kg of tart apples with a butter crust baked at 190°C for about 55 minutes.",
      evidence: "Recipe shared directly with the user including ingredient weights and a 190°C bake for 50–55 minutes.",
      tags: ["recipe", "dessert"],
      facets: ["dessert", "technique"],
      confidence: 0.66
    }
  }
];

export function formatDate(date = new Date()) {
  const iso = date.toISOString();
  return iso.slice(0, 10);
}

export function matchByAlias(library, text) {
  const haystack = String(text || "");
  for (const entry of library) {
    if (!entry || !Array.isArray(entry.aliases)) continue;
    for (const pattern of entry.aliases) {
      try {
        if (pattern.test(haystack)) {
          return entry;
        }
      } catch {}
    }
  }
  return null;
}
