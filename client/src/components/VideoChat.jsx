import React, { useEffect, useRef, useState, useCallback } from "react";
import { ToastContainer, toast } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";
import "./VideoChat.css";

// AES-GCM key gen & encrypt/decrypt
async function generateMediaKey() {
  return crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
}
async function encryptData(data, key, iv) {
  return crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
}
async function decryptData(data, key, iv) {
  return crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
}
function getRandomIV() {
  return crypto.getRandomValues(new Uint8Array(12));
}

const iceConfig = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    {
      urls: "turn:turn.example.com:3478",
      username: "user",
      credential: "pass",
    },
  ],
};

export default function VideoChat({ ws, clientId, recipientId }) {
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [callStatus, setCallStatus] = useState("idle"); // idle, calling, in_call

  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const pcRef = useRef(null);
  const mediaKeyRef = useRef(null);
  const incomingIceBuffer = useRef([]);

  // ========== transforms ==========
  const setupSenderTransform = (sender) => {
    if (!mediaKeyRef.current || sender.track.kind !== "video") return;
    if (!sender.createEncodedStreams) return;
    let streams;
    try {
      streams = sender.createEncodedStreams();
    } catch (e) {
      console.warn("Sender.createEncodedStreams failed:", e);
      return;
    }
    const { readable, writable } = streams;
    const t = new TransformStream({
      async transform(frame, ctrl) {
        const iv = getRandomIV();
        const enc = await encryptData(frame.data, mediaKeyRef.current, iv);
        const ivArr = new Uint8Array(iv),
          encArr = new Uint8Array(enc),
          buf = new Uint8Array(ivArr.length + encArr.length);
        buf.set(ivArr, 0);
        buf.set(encArr, ivArr.length);
        frame.data = buf.buffer;
        ctrl.enqueue(frame);
      },
    });
    readable.pipeThrough(t).pipeTo(writable);
  };

  const setupReceiverTransform = (receiver) => {
    if (!mediaKeyRef.current || receiver.track.kind !== "video") return;
    if (!receiver.createEncodedStreams) return;
    let streams;
    try {
      streams = receiver.createEncodedStreams();
    } catch (e) {
      console.warn("Receiver.createEncodedStreams failed:", e);
      return;
    }
    const { readable, writable } = streams;
    const t = new TransformStream({
      async transform(frame, ctrl) {
        const arr = new Uint8Array(frame.data);
        const iv = arr.slice(0, 12);
        const enc = arr.slice(12).buffer;
        const dec = await decryptData(enc, mediaKeyRef.current, iv);
        frame.data = dec;
        ctrl.enqueue(frame);
      },
    });
    readable.pipeThrough(t).pipeTo(writable);
  };

  // send via WS
  const sendSignal = (signalType, payload) =>
    ws.send(
      JSON.stringify({
        type: "video_signal",
        signalType,
        [signalType === "ice_candidate" ? "candidate" : "offer" in payload ? "offer" : "answer"]:
          payload,
        clientId,
        recipientId,
      })
    );

  // ========== signalling ==========
  useEffect(() => {
    if (!ws) return;
    // pre-generate media key
    generateMediaKey().then((k) => (mediaKeyRef.current = k));

    const onMessage = async (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type !== "video_signal") return;

      // OFFER path
      if (msg.signalType === "video_offer") {
        const pc = new RTCPeerConnection(iceConfig);
        pcRef.current = pc;
        incomingIceBuffer.current = [];

        // 1) сразу заявляем sendrecv для обеих дорожек
        pc.addTransceiver("video", { direction: "sendrecv" });
        pc.addTransceiver("audio", { direction: "sendrecv" });

        // 2) локалка
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true,
        });
        setLocalStream(stream);
        localVideoRef.current.srcObject = stream;
        stream.getTracks().forEach((t) => {
          const s = pc.addTrack(t, stream);
          setupSenderTransform(s);
        });

        // 3) ICE outgoing
        pc.onicecandidate = (e) => {
          if (e.candidate) sendSignal("ice_candidate", e.candidate);
        };

        // 4) buffer incoming ICE until remoteDesc
        const onIceSignal = async (ev) => {
          const d = ev.detail;
          if (d.signalType === "ice_candidate") {
            if (pc.remoteDescription && pc.remoteDescription.type) {
              await pc.addIceCandidate(new RTCIceCandidate(d.candidate));
            } else {
              incomingIceBuffer.current.push(d.candidate);
            }
          }
        };
        document.addEventListener("videoSignal", onIceSignal);

        // 5) receive tracks
        pc.ontrack = (e) => {
          setupReceiverTransform(e.receiver);
          const [rs] = e.streams;
          setRemoteStream(rs);
          remoteVideoRef.current.srcObject = rs;
        };

        // 6) set offer
        await pc.setRemoteDescription(new RTCSessionDescription(msg.offer));

        // 7) flush ICE
        for (const c of incomingIceBuffer.current) {
          await pc.addIceCandidate(new RTCIceCandidate(c));
        }
        incomingIceBuffer.current = [];
        document.removeEventListener("videoSignal", onIceSignal);

        // 8) create & send answer
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendSignal("video_answer", pc.localDescription);

        setCallStatus("in_call");
        return;
      }

      // ANSWER path
      if (msg.signalType === "video_answer") {
        const pc = pcRef.current;
        if (!pc) return;
        await pc.setRemoteDescription(new RTCSessionDescription(msg.answer));
        setCallStatus("in_call");
        return;
      }

      // ICE path
      if (msg.signalType === "ice_candidate") {
        const pc = pcRef.current;
        if (!pc) return;
        if (pc.remoteDescription && pc.remoteDescription.type) {
          await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
        } else {
          incomingIceBuffer.current.push(msg.candidate);
        }
      }
    };

    ws.addEventListener("message", onMessage);
    return () => ws.removeEventListener("message", onMessage);
  }, [ws, clientId, recipientId]);

  // ========== Initiator ==========
  const startCall = useCallback(async () => {
    const pc = new RTCPeerConnection(iceConfig);
    pcRef.current = pc;
    incomingIceBuffer.current = [];

    // 1) sendrecv
    pc.addTransceiver("video", { direction: "sendrecv" });
    pc.addTransceiver("audio", { direction: "sendrecv" });

    // 2) local
    const stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    });
    setLocalStream(stream);
    localVideoRef.current.srcObject = stream;
    stream.getTracks().forEach((t) => {
      const s = pc.addTrack(t, stream);
      setupSenderTransform(s);
    });

    // 3) incoming tracks
    pc.ontrack = (e) => {
      setupReceiverTransform(e.receiver);
      const [rs] = e.streams;
      setRemoteStream(rs);
      remoteVideoRef.current.srcObject = rs;
    };

    // 4) ICE out
    pc.onicecandidate = (e) => {
      if (e.candidate) sendSignal("ice_candidate", e.candidate);
    };

    // 5) create & send offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendSignal("video_offer", pc.localDescription);

    setCallStatus("calling");
  }, [ws, clientId, recipientId]);

  const endCall = () => {
    pcRef.current?.close();
    localStream?.getTracks().forEach((t) => t.stop());
    remoteStream?.getTracks().forEach((t) => t.stop());
    setLocalStream(null);
    setRemoteStream(null);
    setCallStatus("idle");
  };

  return (
    <div className="video-chat-container">
      <h2>Video Chat</h2>
      {callStatus === "idle" ? (
        <button onClick={startCall}>Начать звонок</button>
      ) : (
        <button onClick={endCall}>Завершить звонок</button>
      )}
      <div className="video-container">
        <div>
          <h3>Ваше видео</h3>
          <video ref={localVideoRef} autoPlay muted playsInline />
        </div>
        <div>
          <h3>Видео собеседника</h3>
          <video ref={remoteVideoRef} autoPlay playsInline />
        </div>
      </div>
      <ToastContainer position="bottom-right" autoClose={3000} />
    </div>
  );
}
