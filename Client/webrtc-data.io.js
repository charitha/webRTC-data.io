//CLIENT

/*todo: 
 * - link sockets to usernames to prevent username spoofing/modification
 */
 
 // Fallbacks for vendor-specific variables until the spec is finalized.

var PeerConnection = window.PeerConnection || window.webkitPeerConnection00 || window.webkitRTCPeerConnection;
var URL = window.URL || window.webkitURL || window.msURL || window.oURL;
var getUserMedia = navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia || navigator.msGetUserMedia;

(function() {

  var rtc;
  if ('undefined' === typeof module) {
    rtc = this.rtc = {};
  } else {
    rtc = module.exports = {};
  }


  // Holds a connection to the server.
  rtc._socket = null;

  // Holds identity for the client
  rtc._me = null;

  // Holds callbacks for certain events.
  rtc._events = {};

  rtc.on = function(eventName, callback) {
    rtc._events[eventName] = rtc._events[eventName] || [];
    rtc._events[eventName].push(callback);
  };

  rtc.fire = function(eventName, _) {
    var events = rtc._events[eventName];
    var args = Array.prototype.slice.call(arguments, 1);

    if (!events) {
      return;
    }

    for (var i = 0, len = events.length; i < len; i++) {
      events[i].apply(null, args);
    }
  };

  // Holds the STUN/ICE server to use for PeerConnections.
  rtc.SERVER = {iceServers:[{url:"stun:stun.l.google.com:19302"}]};

  // Reference to the lone PeerConnection instance.
  rtc.peerConnections = {};

  // Array of known peer socket ids
  rtc.connections = [];
  // Stream-related variables.
  rtc.streams = [];


  // Reference to the data channels
  rtc.dataChannels = {};

  // PeerConnection datachannel configuration
  rtc.dataChannelConfig = {optional: [ {RtpDataChannels: true} ] };


  // check whether data channel is supported.
  rtc.checkDataChannelSupport = function() {
    try {
      // raises exception if createDataChannel is not supported
      var pc = new PeerConnection(rtc.SERVER, rtc.dataChannelConfig);
      channel = pc.createDataChannel('supportCheck', {reliable: false}); /*reliable = true hopefully soon! */
      channel.close();
      return true;
    } catch(e) {
      return false;
    }
  };

  rtc.dataChannelSupport = rtc.checkDataChannelSupport();

  /**
   * Connects to the websocket server.
   */
  rtc.connect = function(server, room, username) {
    room = room || ""; // by default, join a room called the blank string
    rtc._socket = new WebSocket(server);

    rtc._socket.onopen = function() {

      rtc._socket.send(JSON.stringify({
        "eventName": "join_room",
        "data":{
          "room": room,
		  "username": username
        }
      }));

      rtc._socket.onmessage = function(msg) {
        var json = JSON.parse(msg.data);
        rtc.fire(json.eventName, json.data);
      };

      rtc._socket.onerror = function(err) {
        console.error('onerror');
        console.error(err);
      };

      rtc._socket.onclose = function(data) {
        rtc.fire('disconnect stream', rtc._socket.id);
        delete rtc.peerConnections[rtc._socket.id];
      };

      rtc.on('get_peers', function(data) {
		console.log("get_peers");
        rtc.connections = data.connections;
        rtc._me = data.you;
        // fire connections event and pass peers
        rtc.fire('connections', rtc.connections);
		// at this point, our connections are ready, fire ready!
		rtc.fire('ready');
      });

      rtc.on('receive_ice_candidate', function(data) {
        var candidate = new RTCIceCandidate(data);
        rtc.peerConnections[data.socketId].addIceCandidate(candidate);
        rtc.fire('receive ice candidate', candidate);
      });

      rtc.on('new_peer_connected', function(data) {
		console.log(data.username+" has joined the chat");
        rtc.connections.push(data.socketId);

        var pc = rtc.createPeerConnection(data.socketId);
		for (var i = 0; i < rtc.streams.length; i++) {
         var stream = rtc.streams[i];
          pc.addStream(stream);
        }
      });

      rtc.on('remove_peer_connected', function(data) {
        rtc.fire('disconnect stream', data.socketId);
        delete rtc.peerConnections[data.socketId];
      });

      rtc.on('receive_offer', function(data) {
        rtc.receiveOffer(data.socketId, data.sdp);
        rtc.fire('receive offer', data);
      });

      rtc.on('receive_answer', function(data) {
        rtc.receiveAnswer(data.socketId, data.sdp);
        rtc.fire('receive answer', data);
      });

      rtc.fire('connect');
    };
  };


  rtc.sendOffers = function() {
    for (var i = 0, len = rtc.connections.length; i < len; i++) {
      var socketId = rtc.connections[i];
      rtc.sendOffer(socketId);
    }
  };

  rtc.onClose = function(data) {
    rtc.on('close_stream', function() {
      rtc.fire('close_stream', data);
    });
  };

  rtc.createPeerConnections = function() {
    for (var i = 0; i < rtc.connections.length; i++) {
      rtc.createPeerConnection(rtc.connections[i]);
	  console.log(rtc.connections[i]);
    }
  };

  rtc.createPeerConnection = function(id) {
	console.log("creating peer conn");
    var config;
    if (rtc.dataChannelSupport)
      config = rtc.dataChannelConfig;

    var pc = rtc.peerConnections[id] = new PeerConnection(rtc.SERVER, config);
	console.log(pc);
    pc.onicecandidate = function(event) {
      if (event.candidate) {
         rtc._socket.send(JSON.stringify({
           "eventName": "send_ice_candidate",
           "data": {
              "label": event.candidate.label,
              "candidate": event.candidate.candidate,
              "socketId": id
           }
         }));
       }
       rtc.fire('ice candidate', event.candidate);
     };

    pc.onopen = function() {
      // TODO: Finalize this API
      rtc.fire('peer connection opened');
    };

    pc.onaddstream = function(event) {
      // TODO: Finalize this API
      rtc.fire('add remote stream', event.stream, id);
    };

    if (rtc.dataChannelSupport) {
      pc.ondatachannel = function (evt) {
        console.log('data channel connecting ' + id);
        rtc.addDataChannel(id, evt.channel);
      };
    }

    return pc;
  };
  
  /* SUPER HACK!
   * https://github.com/Peer5/ShareFest/blob/master/public/js/peerConnectionImplChrome.js#L201
   * https://github.com/Peer5/ShareFest/issues/10
   * This is a wicked impressive hack, lovingly taken from ShareFest
   * This function should retain the following copyright per the apache 2.0 license:
   * https://github.com/Peer5/ShareFest/blob/master/LICENSE 
   */
	rtc. transformOutgoingSdp = function (sdp) {
		var splitted = sdp.split("b=AS:30");
		var newSDP = splitted[0] + "b=AS:1638400" + splitted[1];
		return newSDP;
	};

  rtc.sendOffer = function(socketId) {
    var pc = rtc.peerConnections[socketId];
    pc.createOffer( function(session_description) {
	session_description.sdp = rtc.transformOutgoingSdp(session_description.sdp);
	console.log(session_description);
    pc.setLocalDescription(session_description);
    rtc._socket.send(JSON.stringify({
        "eventName": "send_offer",
        "data":{
            "socketId": socketId,
            "sdp": session_description
            }
        }));
    });
  };


  rtc.receiveOffer = function(socketId, sdp) {
    var pc = rtc.peerConnections[socketId];
    pc.setRemoteDescription(new RTCSessionDescription(sdp));
    rtc.sendAnswer(socketId);
  };


  rtc.sendAnswer = function(socketId) {
    var pc = rtc.peerConnections[socketId];
    pc.createAnswer( function(session_description) {
	session_description.sdp = rtc.transformOutgoingSdp(session_description.sdp);
	console.log(session_description);
    pc.setLocalDescription(session_description);
    rtc._socket.send(JSON.stringify({
        "eventName": "send_answer",
        "data":{
            "socketId": socketId,
            "sdp": session_description
            }
        }));
    var offer = pc.remoteDescription;
    });
  };


  rtc.receiveAnswer = function(socketId, sdp) {
    var pc = rtc.peerConnections[socketId];
    pc.setRemoteDescription(new RTCSessionDescription(sdp));
  };

  rtc.addStreams = function() {
    for (var i = 0; i < rtc.streams.length; i++) {
      var stream = rtc.streams[i];
      for (var connection in rtc.peerConnections) {
        rtc.peerConnections[connection].addStream(stream);
      }
    }
  };

  rtc.attachStream = function(stream, domId) {
    document.getElementById(domId).src = URL.createObjectURL(stream);
  };


  rtc.createDataChannel = function(pcOrId, label) {
    if (!rtc.dataChannelSupport) {
      alert('webRTC data channel is not yet supported in this browser,' +
            ' or you must turn on experimental flags');
      return;
    }
	
	id = pcOrId;
	pc = rtc.peerConnections[pcOrId];

    if (!id)
      throw new Error ('attempt to createDataChannel with unknown id');

    if (!pc || !(pc instanceof PeerConnection))
      throw new Error ('attempt to createDataChannel without peerConnection');

    // need a label
    label = label || 'fileTransfer' || String(id);

    // chrome only supports reliable false atm.
    options = {reliable: false};
	
    try {
      console.log('createDataChannel ' + id);
      channel = pc.createDataChannel(label, options);
    } catch (error) {
      console.log('seems that DataChannel is NOT actually supported!');
      throw error;
    }

    return rtc.addDataChannel(id, channel);
  };

  rtc.addDataChannel = function(id, channel) {

    channel.onopen = function() {
      console.log('data stream open ' + id);
      rtc.fire('data stream open', channel);
    };

    channel.onclose = function(event) {
      delete rtc.dataChannels[id];
      console.log('data stream close ' + id);
      rtc.fire('data stream close', channel);
    };

    channel.onmessage = function(message) {
	  //warning - under heavy data usage the following will print out a whole lot
      //console.log('data stream message ' + id);
      //console.log(message);
      rtc.fire('data stream data', channel, message.data);
    };

    channel.onerror = function(err) {
      console.log('data stream error ' + id + ': ' + err);
      rtc.fire('data stream error', channel, err);
    };

    // track dataChannel
    rtc.dataChannels[id] = channel;
    return channel;
  };

  rtc.addDataChannels = function() {
    if (!rtc.dataChannelSupport)
      return;

    for (var connection in rtc.peerConnections)
      rtc.createDataChannel(connection);
  };


  rtc.on('ready', function() {
    rtc.createPeerConnections();
    rtc.addStreams();
    rtc.addDataChannels();
    rtc.sendOffers();
  });

}).call(this);
