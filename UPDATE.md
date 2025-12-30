# update log 🚀

hey! here's everything we've added and improved recently. the app is getting super powerful!

## new features

### 📊 advanced analytics
- **aggregation pipeline builder**: you can now build complex pipelines right in the ui.
- **live monitoring**: watch your database operations in real-time (ops/sec)[experimental].
- **slow query profiler**: catch those heavy queries that are slowing you down.
- **enhanced stats**: see host info, uptime, and more.

### 📥 data tools
- **bulk import**: easily import json or csv data into your collections.
- **validation**: imports are checked for dangerous patterns *before* they hit the server.
- **formatting**: messy json? click the lightning bolt to clean it up instantly.

## improvements

### 🛡️ security
- **read-only analytics**: we blocked `$out` and `$merge` stages in the analytics tool so you can't accidentally overwrite your data.
- **better sanitization**: improved checks against nosql injection attacks.

### 🎨 ui/ux
- **free tier support**: the dashboard now gracefully handles "shared cluster" limitations.
    - hides empty charts (like 0 mb memory).
    - keeps useful stats visible (ops, network, connections).
- **cleaner layout**: improved spacing, glassmorphism, and better mobile responsiveness.

## technical stuff
- **security**: blocked `$out` and `$merge` in aggregations.
- handled tons of edge cases for mongodb atlas free tier.

enjoy building! 🛠️
