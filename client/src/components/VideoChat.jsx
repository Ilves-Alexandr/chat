import React, { useEffect, useRef, useState, useCallback } from "react";
import { ToastContainer, toast } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";
import "./VideoChat.css";

// AES-GCM media encryption/decryption helpers
async function generateMediaKey() {
  return await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
}

async function encryptData(data, key, iv) {
  return await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
}

async function decryptData(data, key, iv) {
  return await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
}

function getRandomIV() {
  return crypto.getRandomValues(new Uint8Array(12));
}

const VideoChat = ({ ws, clientId, recipientId }) => {
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [callStatus, setCallStatus] = useState("idle");
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [videoEnabled, setVideoEnabled] = useState(true);
  const [incomingOffer, setIncomingOffer] = useState(null);

  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const mediaKeyRef = useRef(null);
  const pendingCandidates = useRef([]);

  const iceServers = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

  // Setup insertable streams for encryption
  const setupSenderTransform = (pc) => {
    pc.getSenders?.().forEach((sender) => {
      if (sender.track?.kind === "video" && sender.createEncodedStreams) {
        const { readable, writable } = sender.createEncodedStreams();
        const encryptTransform = new TransformStream({
          async transform(frame, controller) {
            const iv = getRandomIV();
            try {
              const encrypted = await encryptData(
                frame.data,
                mediaKeyRef.current,
                iv
              );
              const ivArr = new Uint8Array(iv);
              const encArr = new Uint8Array(encrypted);
              const combined = new Uint8Array(ivArr.length + encArr.length);
              combined.set(ivArr, 0);
              combined.set(encArr, ivArr.length);
              frame.data = combined.buffer;
              controller.enqueue(frame);
            } catch (e) {
              console.error("Encryption error:", e);
            }
          },
        });
        readable.pipeThrough(encryptTransform).pipeTo(writable);
      }
    });
  };

  // Setup insertable streams for decryption
  const setupReceiverTransform = (pc) => {
    pc.getReceivers?.().forEach((receiver) => {
      if (receiver.track?.kind === "video" && receiver.createEncodedStreams) {
        const { readable, writable } = receiver.createEncodedStreams();
        const decryptTransform = new TransformStream({
          async transform(frame, controller) {
            try {
              const dataArr = new Uint8Array(frame.data);
              const iv = dataArr.slice(0, 12);
              const encrypted = dataArr.slice(12).buffer;
              const decrypted = await decryptData(
                encrypted,
                mediaKeyRef.current,
                iv
              );
              frame.data = decrypted;
              controller.enqueue(frame);
            } catch (e) {
              console.error("Decryption error:", e);
            }
          },
        });
        readable.pipeThrough(decryptTransform).pipeTo(writable);
      }
    });
  };

  // WebSocket message handler
  useEffect(() => {
    if (!ws) return;
    const onMessage = (e) => {
      const d = JSON.parse(e.data);
      if (d.type === "video_signal") {
        if (d.signalType === "video_offer") setIncomingOffer(d);
        else
          document.dispatchEvent(new CustomEvent("videoSignal", { detail: d }));
      }
    };
    ws.addEventListener("message", onMessage);
    return () => ws.removeEventListener("message", onMessage);
  }, [ws]);

  // Common WebRTC signal handler
  useEffect(() => {
    const handler = async (e) => {
      const d = e.detail;
      const pc = peerConnectionRef.current;
      if (!pc) return;
      if (d.signalType === "video_answer") {
        await pc.setRemoteDescription(new RTCSessionDescription(d.answer));
        setCallStatus("in_call");
      } else if (d.signalType === "ice_candidate") {
        // Buffer until remoteDescription is set
        if (!pc.remoteDescription) pendingCandidates.current.push(d.candidate);
        else await pc.addIceCandidate(new RTCIceCandidate(d.candidate));
      }
    };
    document.addEventListener("videoSignal", handler);
    return () => document.removeEventListener("videoSignal", handler);
  }, []);

  // Accept incoming call
  const accept = () => {
    if (incomingOffer) handleOffer(incomingOffer);
    setIncomingOffer(null);
  };
  const reject = () => {
    setIncomingOffer(null);
    toast.info("Звонок отклонён");
  };

  // Create and send offer
  const makeOffer = useCallback(async () => {
    const pc = peerConnectionRef.current;
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    ws.send(
      JSON.stringify({
        type: "video_signal",
        signalType: "video_offer",
        offer: pc.localDescription,
        clientId,
        recipientId,
      })
    );
  }, [ws, clientId, recipientId]);

  // Start call as caller
  const startCall = async () => {
    if (!mediaKeyRef.current) mediaKeyRef.current = await generateMediaKey();
    const pc = new RTCPeerConnection(iceServers);
    peerConnectionRef.current = pc;
    // force sendrecv transceivers
    const videoTrans = pc.addTransceiver("video", { direction: "sendrecv" });
    const audioTrans = pc.addTransceiver("audio", { direction: "sendrecv" });
    setupSenderTransform(pc);
    const stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    });
    stream.getTracks().forEach((t) => pc.addTrack(t, stream));
    setLocalStream(stream);
    localVideoRef.current.srcObject = stream;
    pc.onicecandidate = (e) => {
      if (e.candidate)
        ws.send(
          JSON.stringify({
            type: "video_signal",
            signalType: "ice_candidate",
            candidate: e.candidate,
            clientId,
            recipientId,
          })
        );
    };
    pc.ontrack = (e) => {
      setupReceiverTransform(pc);
      const [remote] = e.streams;
      setRemoteStream(remote);
      remoteVideoRef.current.srcObject = remote;
      remoteVideoRef.current.play().catch(() => {});
    };

    await makeOffer();
    setCallStatus("calling");
  };

  // Handle an incoming offer (callee)
  const handleOffer = useCallback(
    async (d) => {
      if (!mediaKeyRef.current) mediaKeyRef.current = await generateMediaKey();
      const pc = new RTCPeerConnection(iceServers);
      peerConnectionRef.current = pc;
      pc.addTransceiver("video", { direction: "sendrecv" });
     pc.addTransceiver("audio", { direction: "sendrecv" });
     setupSenderTransform(pc);
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      stream.getTracks().forEach((t) => pc.addTrack(t, stream));
      setLocalStream(stream);
      localVideoRef.current.srcObject = stream;
      setupSenderTransform(pc);

      pc.onicecandidate = (e) => {
        if (e.candidate)
          ws.send(
            JSON.stringify({
              type: "video_signal",
              signalType: "ice_candidate",
              candidate: e.candidate,
              clientId,
              recipientId,
            })
          );
      };
      pc.ontrack = (e) => {
        setupReceiverTransform(pc);
        const [remote] = e.streams;
        setRemoteStream(remote);
        remoteVideoRef.current.srcObject = remote;
        remoteVideoRef.current.play().catch(() => {});
      };

      // 1) set remote
      await pc.setRemoteDescription(new RTCSessionDescription(d.offer));
      // 2) flush buffered candidates
      for (const cand of pendingCandidates.current) {
        await pc.addIceCandidate(new RTCIceCandidate(cand));
      }
      pendingCandidates.current = [];
      // 3) create and send answer
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      ws.send(
        JSON.stringify({
          type: "video_signal",
          signalType: "video_answer",
          answer: pc.localDescription,
          clientId,
          recipientId,
        })
      );
      setCallStatus("in_call");
    },
    [ws, clientId, recipientId]
  );

  const toggleAudio = () => {
    localStream?.getAudioTracks().forEach((t) => (t.enabled = !t.enabled));
    setAudioEnabled((a) => !a);
  };
  const toggleVideo = () => {
    localStream?.getVideoTracks().forEach((t) => (t.enabled = !t.enabled));
    setVideoEnabled((v) => !v);
  };
  const endCall = () => {
    peerConnectionRef.current?.close();
    localStream?.getTracks().forEach((t) => t.stop());
    remoteStream?.getTracks()?.forEach((t) => t.stop());
    setLocalStream(null);
    setRemoteStream(null);
    setCallStatus("idle");
    pendingCandidates.current = [];
  };

  return (
    <div className="video-chat-container">
      <h2>Video Chat</h2>
      {incomingOffer && (
        <div className="incoming-call-banner">
          <p>Входящий звонок от {incomingOffer.clientId}</p>
          <button onClick={accept}>Принять</button>
          <button onClick={reject}>Отклонить</button>
        </div>
      )}
      {callStatus === "idle" ? (
        <button onClick={startCall}>Начать звонок</button>
      ) : (
        <button onClick={endCall}>Завершить звонок</button>
      )}
      <button onClick={toggleAudio}>
        {audioEnabled ? "Выключить микрофон" : "Включить микрофон"}
      </button>
      <button onClick={toggleVideo}>
        {videoEnabled ? "Выключить камеру" : "Включить камеру"}
      </button>
      <div className="video-container">
        <div className="local-video">
          <h3>Ваше видео</h3>
          <video ref={localVideoRef} autoPlay muted playsInline />
        </div>
        <div className="remote-video">
          <h3>Видео собеседника</h3>
          <video ref={remoteVideoRef} autoPlay playsInline />
        </div>
      </div>
      <ToastContainer position="bottom-right" autoClose={3000} />
    </div>
  );
};

export default VideoChat;
