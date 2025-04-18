// VideoChat.jsx
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

const VideoChat = ({ ws, clientId }) => {
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [callStatus, setCallStatus] = useState("idle"); // idle, calling, in_call
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [videoEnabled, setVideoEnabled] = useState(true);
  const [incomingOffer, setIncomingOffer] = useState(null);

  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const mediaKeyRef = useRef(null);

  const iceServers = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

  // Insertable Streams: sender-side encryption
  const setupSenderTransform = (pc) => {
    pc.getSenders?.().forEach(sender => {
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
              // prepend IV
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
          }
        });
        readable.pipeThrough(encryptTransform).pipeTo(writable);
        console.log("Sender transform established");
      }
    });
  };

  // Insertable Streams: receiver-side decryption
  const setupReceiverTransform = (pc) => {
    pc.getReceivers?.().forEach(receiver => {
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
          }
        });
        readable.pipeThrough(decryptTransform).pipeTo(writable);
        console.log("Receiver transform established");
      }
    });
  };

  // Handle incoming WS messages for video signaling
  useEffect(() => {
    if (!ws) return;
    const onMessage = event => {
      const data = JSON.parse(event.data);
      if (data.type === "video_signal") {
        if (data.signalType === "video_offer") {
          setIncomingOffer(data);
        } else {
          document.dispatchEvent(
            new CustomEvent("videoSignal", { detail: data })
          );
        }
      }
    };
    ws.addEventListener("message", onMessage);
    return () => ws.removeEventListener("message", onMessage);
  }, [ws]);

  // Common signal handler: answer & ICE
  useEffect(() => {
    const handler = e => {
      const d = e.detail;
      if (d.signalType === "video_answer") {
        peerConnectionRef.current?.setRemoteDescription(
          new RTCSessionDescription(d.answer)
        ).then(() => setCallStatus("in_call"));
      } else if (d.signalType === "ice_candidate") {
        peerConnectionRef.current?.addIceCandidate(
          new RTCIceCandidate(d.candidate)
        ).catch(console.error);
      }
    };
    document.addEventListener("videoSignal", handler);
    return () => document.removeEventListener("videoSignal", handler);
  }, []);

  // Accept / Reject incoming offer
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
    peerConnectionRef.current.createOffer()
      .then(offer => peerConnectionRef.current.setLocalDescription(offer))
      .then(() => {
        ws.send(JSON.stringify({
          type: "video_signal",
          signalType: "video_offer",
          offer: peerConnectionRef.current.localDescription,
          clientId
        }));
      });
  }, [ws, clientId]);

  // Start a call
  const startCall = async () => {
    if (!mediaKeyRef.current) {
      mediaKeyRef.current = await generateMediaKey();
      console.log("Media key generated");
    }
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    setLocalStream(stream);
    localVideoRef.current.srcObject = stream;

    const pc = new RTCPeerConnection(iceServers);
    peerConnectionRef.current = pc;
    stream.getTracks().forEach(t => pc.addTrack(t, stream));
    setupSenderTransform(pc);

    pc.onicecandidate = e => {
      if (e.candidate && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "video_signal", signalType: "ice_candidate", candidate: e.candidate, clientId }));
      }
    };
    pc.ontrack = e => {
      setupReceiverTransform(pc);
      remoteVideoRef.current.srcObject = e.streams[0];
      setRemoteStream(e.streams[0]);
    };

    await makeOffer();
    setCallStatus("calling");
  };

  // Handle incoming offer and send answer
  const handleOffer = useCallback(async data => {
    if (!mediaKeyRef.current) mediaKeyRef.current = await generateMediaKey();
    const pc = new RTCPeerConnection(iceServers);
    peerConnectionRef.current = pc;

    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    setLocalStream(stream);
    localVideoRef.current.srcObject = stream;
    stream.getTracks().forEach(t => pc.addTrack(t, stream));
    setupSenderTransform(pc);

    pc.onicecandidate = e => {
      if (e.candidate && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "video_signal", signalType: "ice_candidate", candidate: e.candidate, clientId }));
      }
    };
    pc.ontrack = e => {
      setupReceiverTransform(pc);
      remoteVideoRef.current.srcObject = e.streams[0];
      setRemoteStream(e.streams[0]);
    };

    await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    ws.send(JSON.stringify({ type: "video_signal", signalType: "video_answer", answer, clientId }));
    setCallStatus("in_call");
  }, [ws, clientId]);

  const toggleAudio = () => localStream?.getAudioTracks().forEach(t => t.enabled = !t.enabled) & setAudioEnabled(a => !a);
  const toggleVideo = () => localStream?.getVideoTracks().forEach(t => t.enabled = !t.enabled) & setVideoEnabled(v => !v);
  const endCall = () => {
    peerConnectionRef.current?.close();
    localStream?.getTracks().forEach(t => t.stop());
    remoteStream?.getTracks().forEach(t => t.stop());
    setLocalStream(null);
    setRemoteStream(null);
    setCallStatus("idle");
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
      {callStatus === "idle"
        ? <button onClick={startCall}>Начать звонок</button>
        : <button onClick={endCall}>Завершить звонок</button>
      }
      <button onClick={toggleAudio}>{audioEnabled ? "Выключить микрофон" : "Включить микрофон"}</button>
      <button onClick={toggleVideo}>{videoEnabled ? "Выключить камеру" : "Включить камеру"}</button>
      <div className="video-container">
        <div className="local-video"><h3>Ваше видео</h3><video ref={localVideoRef} autoPlay muted playsInline /></div>
        <div className="remote-video"><h3>Видео собеседника</h3><video ref={remoteVideoRef} autoPlay playsInline /></div>
      </div>
      <ToastContainer position="bottom-right" autoClose={3000} />
    </div>
  );
};

export default VideoChat;
