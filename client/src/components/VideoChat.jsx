import React, { useEffect, useRef, useState, useCallback } from "react";
import { ToastContainer, toast } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";
import "./VideoChat.css";

async function generateMediaKey() {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
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

const VideoChat = ({ ws, clientId, recipientId }) => {
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [callStatus, setCallStatus] = useState("idle"); // idle, calling, in_call
  const [incomingOffer, setIncomingOffer] = useState(null);

  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const pcRef = useRef(null);
  const mediaKeyRef = useRef(null);
  const bufferedIce = useRef([]);
  const initializedReceivers = new WeakSet();

  // ============ Sender transform ============
  const setupSenderTransform = (sender) => {
    if (!sender.createEncodedStreams || sender.track.kind !== "video") return;
    let streams;
    try {
      streams = sender.createEncodedStreams();
    } catch (err) {
      console.warn("🔐 Sender.createEncodedStreams failed:", err);
      return;
    }
    const { readable, writable } = streams;
    const transform = new TransformStream({
      async transform(frame, ctrl) {
        const iv = getRandomIV();
        try {
          const enc = await encryptData(frame.data, mediaKeyRef.current, iv);
          const ivArr = new Uint8Array(iv);
          const encArr = new Uint8Array(enc);
          const combined = new Uint8Array(ivArr.length + encArr.length);
          combined.set(ivArr, 0);
          combined.set(encArr, ivArr.length);
          frame.data = combined.buffer;
          ctrl.enqueue(frame);
        } catch (e) {
          console.error("🔐 Encryption error:", e);
        }
      },
    });
    readable.pipeThrough(transform).pipeTo(writable);
    console.log("✅ Sender transform established for sender", sender.track.id);
  };

  // ============ Receiver transform ============
  const setupReceiverTransform = (receiver) => {
    if (initializedReceivers.has(receiver)) {
      console.log("⏭ Receiver already initialized:", receiver.track.id);
      return;
    }

    if (!receiver.createEncodedStreams || receiver.track.kind !== "video") {
      console.log("— skipping transform, not a video receiver");
      initializedReceivers.add(receiver);
      return;
    }
    let streams;
    try {
      streams = receiver.createEncodedStreams();
    } catch (err) {
      console.error("🔓 Receiver.createEncodedStreams failed:", err, {
        signalingState: pcRef.current?.signalingState,
        iceConnectionState: pcRef.current?.iceConnectionState,
        trackReadyState: receiver.track.readyState,
      });
      initializedReceivers.add(receiver);
      return;
    }
    initializedReceivers.add(receiver);
    const { readable, writable } = streams;
    const transform = new TransformStream({
      async transform(frame, ctrl) {
        try {
          const dataArr = new Uint8Array(frame.data);
          const iv = dataArr.slice(0, 12);
          const enc = dataArr.slice(12).buffer;
          const dec = await decryptData(enc, mediaKeyRef.current, iv);
          frame.data = dec;
          ctrl.enqueue(frame);
        } catch (e) {
          console.error("🔓 Decryption error:", e);
        }
      },
    });
    readable.pipeThrough(transform).pipeTo(writable);
    console.log(
      "✅ Receiver transform established for receiver",
      receiver.track.id
    );
  };
  // ============ WebSocket signalling ============
  useEffect(() => {
    if (!ws) return;
    const onMsg = (e) => {
      const d = JSON.parse(e.data);
      if (d.type !== "video_signal") return;
      if (d.signalType === "video_offer") setIncomingOffer(d);
      else
        document.dispatchEvent(new CustomEvent("videoSignal", { detail: d }));
    };
    ws.addEventListener("message", onMsg);
    return () => ws.removeEventListener("message", onMsg);
  }, [ws]);

  useEffect(() => {
    const handler = async (e) => {
      const d = e.detail;
      const pc = pcRef.current;
      if (!pc) return;
      if (d.signalType === "video_answer") {
        await pc.setRemoteDescription(new RTCSessionDescription(d.answer));
        pc.getReceivers().forEach(setupReceiverTransform);
        setCallStatus("in_call");
      }
      if (d.signalType === "ice_candidate") {
        if (pc.signalingState === "closed") return;
        if (!pc.remoteDescription?.type) {
          bufferedIce.current.push(d.candidate);
        } else {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(d.candidate));
            console.log("✅ ICE candidate added");
          } catch (err) {
            console.error("🔴 ICE candidate add error:", err);
          }
        }
      }
    };
    document.addEventListener("videoSignal", handler);
    return () => document.removeEventListener("videoSignal", handler);
  }, []);
  // ============ Call control ============
  const acceptCall = () => {
    if (incomingOffer) handleOffer(incomingOffer);
    setIncomingOffer(null);
  };
  const rejectCall = () => {
    setIncomingOffer(null);
    toast.info("Звонок отклонён");
  };
  const makeOffer = useCallback(async () => {
    const pc = pcRef.current;
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    console.log("🔄 [makeOffer] local SDP:", pc.localDescription.sdp);
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
  // ============ Initiator ============
  const startCall = async () => {
    if (!mediaKeyRef.current) mediaKeyRef.current = await generateMediaKey();
    const pc = new RTCPeerConnection(iceConfig);
    pcRef.current = pc;
    const stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    });
    setLocalStream(stream);
    localVideoRef.current.srcObject = stream;
    stream.getTracks().forEach((track) => {
      const sender = pc.addTrack(track, stream);
      setupSenderTransform(sender);
    });
    // — ICE candidates
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        ws.send(
          JSON.stringify({
            type: "video_signal",
            signalType: "ice_candidate",
            candidate: e.candidate,
            clientId,
            recipientId,
          })
        );
      }
    };
    // — Получение треков
    pc.ontrack = (e) => {
      console.log(
        "📥 ontrack:",
        e.receiver.track.kind,
        "streams:",
        e.streams.map((s) => s.id)
      );
      const [remote] = e.streams;
      setRemoteStream(remote);
      remoteVideoRef.current.srcObject = remote;
      remoteVideoRef.current.play().catch(() => {});
    };

    await makeOffer();
    setCallStatus("calling");
  };
  // ============ Receiver ============
  const handleOffer = useCallback(
    async (d) => {
      if (!mediaKeyRef.current) mediaKeyRef.current = await generateMediaKey();
      const pc = new RTCPeerConnection(iceConfig);
      pcRef.current = pc;
      // — Резервируем ресиверы ДО setRemoteDescription
      const transVideo = pc.addTransceiver("video", { direction: "sendrecv" });
      const transAudio = pc.addTransceiver("audio", { direction: "sendrecv" });
      setupReceiverTransform(transVideo.receiver);
      setupReceiverTransform(transAudio.receiver);
      // — Локальные треки + шифрование
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      setLocalStream(stream);
      stream.getTracks().forEach((track) => {
        const sender = pc.addTrack(track, stream);
        setupSenderTransform(sender);
      });
      pc.onicecandidate = (e) => {
        if (e.candidate) {
          ws.send(
            JSON.stringify({
              type: "video_signal",
              signalType: "ice_candidate",
              candidate: e.candidate,
              clientId,
              recipientId,
            })
          );
        }
      };

      pc.ontrack = (e) => {
        console.log(
          "📥 ontrack:",
          e.receiver.track.kind,
          "streams:",
          e.streams.map((s) => s.id)
        );
        const [remote] = e.streams;
        setRemoteStream(remote);
        remoteVideoRef.current.srcObject = remote;
        remoteVideoRef.current.play().catch(() => {});
      };

      console.log("🔄 [handleOffer] setting remote description");
      await pc.setRemoteDescription(new RTCSessionDescription(d.offer));
      // flush ICE
      for (const cand of bufferedIce.current) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(cand));
        } catch {}
      }
      bufferedIce.current = [];
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      console.log(
        "🔄 [handleOffer] local SDP answer:",
        pc.localDescription.sdp
      );
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

  const endCall = () => {
    pcRef.current?.close();
    localStream?.getTracks().forEach((t) => t.stop());
    remoteStream?.getTracks().forEach((t) => t.stop());
    setLocalStream(null);
    setRemoteStream(null);
    setCallStatus("idle");
    bufferedIce.current = [];
    initializedReceivers.clear();
  };

  return (
    <div className="video-chat-container">
      <h2>Video Chat</h2>
      {incomingOffer && (
        <div className="incoming-call-banner">
          <p>Входящий звонок от {incomingOffer.clientId}</p>
          <button className="btn" onClick={acceptCall}>
            Принять
          </button>
          <button className="btn" onClick={rejectCall}>
            Отклонить
          </button>
        </div>
      )}
      {callStatus === "idle" ? (
        <button className="btn" onClick={startCall}>
          Начать звонок
        </button>
      ) : (
        <button className="btn" onClick={endCall}>
          Завершить звонок
        </button>
      )}
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
