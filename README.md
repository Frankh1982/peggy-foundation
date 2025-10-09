# PEG Foundation v3 (KDN + Inspector + Clean Profiles)

**What's new**
- Fix: Assistant alias no longer overwrites user name.
- Evidence for assistant name uses `{"assistant":{"alias":"Peggy"}}`.
- Prompt teaches this split and includes alias in the context card.
- Safety-net GAP ignores courtesy questions like “How can I help you?”

**Run**
```bash
npm install
cp .env.example .env  # add OPENAI_API_KEY
npm start
# open http://localhost:8787
```
