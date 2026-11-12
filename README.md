# about_me

**About Me · 1000 things to write about**: an installable web app (PWA) where anyone can write their own book of 1000 questions about their life.

- Sign in with Google, pick a unique username, set your own password (asked every time the app opens) and a reader password.
- Friends read your book with your username + reader password. Read-only, and they can react with emojis.
- Works offline. Answers save on the phone and sync to Firebase when back online.
- Features: dice roll, focus mode, mood check-in & mood calendar, time capsules, then vs now, stickers, year wrapped, share cards, shelf, profile, free pages, print as a book, backup, light/dark mode.

## Files
- `index.html`: the app (UI, styles, and the 1000 questions)
- `live.js`: Firebase sign-in, database, offline sync, usernames, reader books, reactions
- `firebase-config.js`: public Firebase project settings
- `sw.js`, `manifest.webmanifest`, `icons/`: offline support and home-screen install
- `firestore.rules`: database rules for both apps on this Firebase project

## Live link
https://shohbeli.github.io/about_me/
Share link format: `https://shohbeli.github.io/about_me/?u=yourusername`
