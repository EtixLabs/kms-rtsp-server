# kms-rtsp-server
RTSP signaling server for Kurento Media Server

# **Not a working project**
This project is a proof of concept, it's not actively maintained at this time and may never be. Use at your own risk.

# Usage

```
yarn && yarn start
```

Configuration via env vars:

- `KMS_WS_URL`: Url of KMS WebSocket endpoint
- `PORT`: RTSP server port
- `SRC_STREAM`: Source stream to be opened by PlayerEndpoint