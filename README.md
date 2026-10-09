# SyncBoard: Open-Source Real-Time Collaborative Canvas & Code Scratchpad

Draw together on a shared canvas and edit a shared code/notes pad, live, in
room-based sessions. Built with Node.js, Express, Socket.io, the HTML5 Canvas
API, Tailwind CSS (CDN) and vanilla JavaScript.

## Run it

```bash
npm install
npm start
# open http://localhost:3000/?room=study-group in two browser tabs
```

## Project structure

```
syncboard/
├── package.json
├── server.js          # Express + Socket.io: rooms, relay, in-memory state
└── public/
    ├── index.html     # Split layout (Tailwind CDN)
    ├── style.css      # Small custom styles
    └── app.js         # Canvas drawing, throttling, socket client
```

## Socket events

| Event            | Direction                | Purpose                                   |
|------------------|--------------------------|-------------------------------------------|
| `join-room`      | client -> server         | Enter a room                              |
| `room-state`     | server -> new client     | Snapshot of strokes + code for late joiners |
| `draw-line`      | client <-> server <-> peers | Batched line segments                  |
| `code-update`    | client <-> server <-> peers | Full scratchpad text                   |
| `clear-canvas`   | client <-> server <-> peers | Wipe the board                         |
| `presence-update`| server -> room           | Number of connected users                 |

## Design notes

- **Throttling:** pointer moves are drawn locally at once but sent in batches every 30 ms.
- **Fixed 1600x900 logical canvas:** identical coordinates for all users regardless of screen size.
- **Code sync:** last-writer-wins on the whole text (simple and explainable). CRDTs (Yjs) are the production upgrade.
- **Storage:** in-memory `Map` per room (empty rooms are removed after 5 minutes). Replace with Redis/MongoDB for persistence.
- **Validation:** room IDs, segment shapes and payload sizes are checked on the server.

## License

MIT
