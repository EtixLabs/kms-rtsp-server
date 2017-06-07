// Copyright (C) 2014-2017 Etix Labs - All Rights Reserved.
//
// All information contained herein is, and remains the property of Etix Labs and its suppliers,
// if any.  The intellectual and technical concepts contained herein are proprietary to Etix Labs
// Dissemination of this information or reproduction of this material is strictly forbidden unless
// prior written permission is obtained from Etix Labs.

const sdp = require('sdp-transform');

module.exports = (net, rtspStream) => options => {
  const { port = 554 } = options;
  let connectionHandler;

  // Start the server
  const server = net.createServer();

  server.on('error', error => {
    console.error('RTSP Server error', error);
    process.exit(1);
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`RTSP server is running on port: ${port}`);
  });

  server.on('connection', socket => {
    if (!connectionHandler) {
      return;
    }

    console.log('New connection');
    const client = createClient(socket, rtspStream);
    connectionHandler(client);
  });

  return {
    onConnection(handler) {
      connectionHandler = handler;
    },
  };
};

// Handle RTSP client
// inspired from https://github.com/watson/rtsp-server/blob/master/index.js
function createClient(socket, rtspStream) {
  const handlers = {};

  // Used to make sure we don't write after the socket is closed
  let connectionClosed = false;

  socket.on('error', error => {
    if (handlers.error) {
      handlers.error(error);
    }
  });

  socket.on('close', (code, reason) => {
    connectionClosed = true;
    if (handlers.close) {
      handlers.close(code, reason);
    }
  });

  const decoder = rtspStream.Decoder();
  const encoder = rtspStream.Encoder();

  decoder.on('request', async request => {
    const response = encoder.response();
    response.setHeader('CSeq', request.headers['cseq']);
    response.setHeader('Date', new Date().toGMTString());

    // Expose a `setBody` method to easily write a body to the response
    let responseBody;
    response.setBody = body => {
      responseBody = body;
    };

    // handleRequest can return a promise if it needs to do async tasks
    await (handleRequest(socket, handlers)(request, response) ||
      Promise.resolve());

    if (responseBody && !connectionClosed) {
      response.setHeader('Content-Length', responseBody.length);
      response.write(responseBody);
    }

    response.end();
  });

  decoder.on('error', error => {
    if (handlers.error) {
      handlers.error(error);
    }
  });

  socket.pipe(decoder);
  encoder.pipe(socket);

  return {
    onError(handler) {
      handlers.error = handler;
    },
    onClose(handler) {
      handlers.close = handler;
    },
    onSetup(handler) {
      handlers.setup = handler;
    },
    onPlay(handler) {
      handlers.play = handler;
    },
    onTeardown(handler) {
      handlers.teardown = handler;
    },
  };
}

function handleRequest(socket, handlers) {
  return (request, response) => {
    console.log('request', request.method, request.uri, request.headers);

    switch (request.method) {
      case 'OPTIONS':
        response.setHeader(
          'Public',
          'OPTIONS, DESCRIBE, SETUP, TEARDOWN, PLAY'
        );
        break;
      case 'DESCRIBE':
        handleDescribe(socket)(request, response);
        break;
      case 'SETUP':
        return handleSetup(socket, handlers)(request, response);
      case 'PLAY':
        return handlePlay(handlers)(request, response);
      case 'TEARDOWN':
        return handleTeardown(handlers)(request, response);
      default:
        // 501 Not Implemented
        response.statusCode = 501;
    }
  };
}

function handleDescribe(socket) {
  return (request, response) => {
    // Only support sdp format
    if (!request.headers['accept'].includes('application/sdp')) {
      // 406 Not Acceptable
      response.statusCode = 406;
      return;
    }

    const sdpDescription = sdp.write(
      Object.assign({}, getSdpBase({ socket }), getSdpMedia())
    );

    console.log('Sending sdp description', sdpDescription);
    response.setBody(sdpDescription);
  };
}

function handleSetup(socket, handlers) {
  return async (request, response) => {
    const sessionId = request.headers['session'] || 4242;
    const { profile, clientPorts } = parseTransport(
      request.headers['transport']
    );

    // Only support udp
    if (profile.includes('TCP')) {
      // 461 Unsupported Transport
      response.statusCode = 461;
      return;
    }

    const { setup } = handlers;

    if (!setup) {
      console.error('Received a SETUP request but no handler was specified');
      response.statusCode = 501;
      return;
    }

    const sdpOffer = sdp.write(
      Object.assign(
        {},
        getSdpBase({ socket, sessionId }),
        getSdpMedia(clientPorts)
      )
    );

    const serverSdp = await setup(sdpOffer);

    // Parse server sdp to retrieve its port
    const { ports, ssrc } = parseServerSdp(sdp.parse(serverSdp));

    response.setHeader(
      'Transport',
      [
        'RTP/AVP',
        'unicast',
        `client_port=${clientPorts.join('-')}`,
        `server_port=${ports.join('-')}`,
        `ssrc=${ssrc}`,
        'mode="PLAY"',
      ].join(';')
    );

    // Again, we don't really care about the session...
    response.setHeader('Session', 4242);
  };
}

function handlePlay(handlers) {
  return async (request, response) => {
    const { play } = handlers;

    if (!play) {
      console.error('Received a PLAY request but no handler was specified');
      response.statusCode = 501;
      return;
    }

    await play(request.uri);
  };
}

function handleTeardown(handlers) {
  return async (request, response) => {
    const { teardown } = handlers;

    if (!teardown) {
      console.error('Received a TEARDOWN request but no handler was specified');
      response.statusCode = 501;
      return;
    }

    await teardown(request.uri);
  };
}

// Parse SETUP transport header
// We're only interested in `clientPorts` for now so we don't parse all the possible attributes
function parseTransport(transport) {
  const [profile, deliveryMode, ...attrs] = transport.split(';');
  let clientPorts = [];

  attrs.forEach(attr => {
    const [name, value] = attr.split('=');
    if (name === 'client_port') {
      clientPorts = value.split('-');
    }
  });

  return { profile, deliveryMode, clientPorts };
}

function parseServerSdp(serverSdp) {
  const ports = [];

  // Asume there's just one `media`, and one `ssrc`
  ports.push(serverSdp.media[0].port);
  if (serverSdp.media[0].rtcp) {
    ports.push(serverSdp.media.rtcp.port);
  }
  return {
    ports,
    ssrc: serverSdp.media[0].ssrcs[0].id,
  };
}

// Generate the base SDP description, using dummy values as origin
// and the client remote addr for the connection information
function getSdpBase({ socket, sessionId = 4242 }) {
  return {
    // We don't really care about the origin... should we ?
    // For now, just populate it with dummy values
    origin: {
      username: '-',
      sessionId,
      sessionVersion: 0,
      netType: 'IN',
      ipVer: 4,
      address: 'localhost',
    },
    connection: {
      // Retrieve version number from 'IPvXX'
      version: parseInt(socket.remoteFamily.substr('IPv'.length)),
      ip: socket.remoteAddress,
    },
    timing: { start: 0, stop: 0 },
  };
}

// Return the `media` part of the SDP offer
function getSdpMedia(clientPorts) {
  const mediaSdp = {
    media: [
      {
        type: 'video',
        // If no port is given (on DESCRIBE), give a dummy port
        port: (clientPorts && parseInt(clientPorts[0])) || 0,
        protocol: 'RTP/AVP',
        payloads: '97',
        rtp: [
          {
            payload: 97,
            codec: 'H264',
            rate: 90000,
          },
        ],
        direction: 'recvonly',
      },
    ],
  };
  if (clientPorts && clientPorts[1]) {
    mediaSdp.media[0].rtcp = { port: clientPorts[1] };
  }
  return mediaSdp;
}
