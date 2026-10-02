# Meeting Master

Live meeting notes from your microphone: a running transcript, AI-written notes, and a to-do list that updates while people talk.

- **Live transcript** (Chrome Web Speech API) that keeps every phrase, with click-to-edit lines and a rolling AI cleanup a few lines behind the speaker.
- **Speaker separation** in the browser (voice pitch and timbre), with names picked up from the conversation.
- **Notes and to-dos** refreshed every few seconds. Tasks come only from real commitments ("I'll…", "can you…") and keep a quote of where they came from. A stronger model writes the final notes when you press Stop.
- **Assistant**: ask about the meeting, or `/add printer issue` to create a task from what was said.
- **All tasks** view across meetings, quick-add with dates (`lunch at Moon on Monday 12:00 @priya !urgent`), Markdown export, and Export/Import of meetings between browsers.
- **Password protected** and served under `/notes`.

Meetings are stored in the browser (localStorage), not on the server.

## Run locally

```bash
npm install
cp .env.local.example .env.local   # then fill it in
npm run dev                        # http://localhost:3100/notes
```

Settings (`.env.local`):

| Variable | |
|---|---|
| `NVIDIA_API_KEY` | free key from [build.nvidia.com](https://build.nvidia.com). Or use `ANTHROPIC_API_KEY` / `AI_GATEWAY_API_KEY` |
| `NVIDIA_MODEL` | model for live notes, e.g. `openai/gpt-oss-20b` |
| `NVIDIA_FINAL_MODEL` | model for the end-of-meeting pass (default `nvidia/nemotron-3-super-120b-a12b`) |
| `NOTES_PASSWORD` | password for the app. In `.env.local`, write a `$` as `\$` |
| `NOTES_SESSION_SECRET` | optional extra secret for signing the login cookie |

## Deploy

Built for Vercel: `vercel deploy --prod`, with the variables above set in the project settings (there, `$` needs no escaping). To serve it under `/notes` on another site, rewrite `/notes/:path*` to this deployment.
