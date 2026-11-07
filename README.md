# Sideline Subs

Phone-friendly substitution planner for youth soccer (7v7 GK-2-3-1 / 8v8 GK-2-3-2).
Tracks minutes, suggests fair subs, queues them with "Sub Made" buttons. Everything is stored on the device (localStorage); no server.

- `index.html` – app UI
- `engine.js` – sub/rotation logic (`node test/engine.test.cjs`)
- `deploy.sh` – tests, then publishes to Home Assistant (if mounted) and GitHub Pages
