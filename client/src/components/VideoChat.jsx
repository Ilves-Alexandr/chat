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

const VideoChat = ({ ws, clientId, recipientId }) => {
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
  const pendingCandidates = useRef([]);

  const iceConfig = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

  // ===== Insertable Streams: sender-side encryption =====
  const setupSenderTransform = (pc) => {
    pc.getSenders?.().forEach((sender) => {
      if (sender.track?.kind === "video" && sender.createEncodedStreams) {
        let streams;
        try {
          streams = sender.createEncodedStreams();
        } catch (err) {
          console.warn("🔐 Sender: не удалось создать encodedStreams", {
            error: err,
            trackKind: sender.track.kind,
            trackId: sender.track.id,
            trackLabel: sender.track.label,
            signalingState: pc.signalingState,
            iceConnectionState: pc.iceConnectionState,
            transceiverMids: pc.getTransceivers().map((t) => t.mid),
          });
          return; // пропускаем этот sender
        }
        const { readable, writable } = streams;
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
              console.error("🔐 Encryption frame error:", e);
            }
          },
        });
        readable.pipeThrough(encryptTransform).pipeTo(writable);
        console.log("✅ Sender transform established for track", sender.track.id);
      }
    });
  };

  // ===== Insertable Streams: receiver-side decryption =====
  const setupReceiverTransform = (pc) => {
    pc.getReceivers?.().forEach((receiver) => {
      if (receiver.track?.kind === "video" && receiver.createEncodedStreams) {
        let streams;
        try {
          streams = receiver.createEncodedStreams();
        } catch (err) {
          console.warn("🔓 Receiver: не удалось создать encodedStreams", {
            error: err,
            trackKind: receiver.track.kind,
            trackId: receiver.track.id,
            trackLabel: receiver.track.label,
            signalingState: pc.signalingState,
            iceConnectionState: pc.iceConnectionState,
            transceiverMids: pc.getTransceivers().map((t) => t.mid),
          });
          return;
        }
        const { readable, writable } = streams;
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
              console.error("🔓 Decryption frame error:", e);
            }
          },
        });
        readable.pipeThrough(decryptTransform).pipeTo(writable);
        console.log("✅ Receiver transform established for track", receiver.track.id);
      }
    });
  };

  // ===== WebSocket signal handler =====
  useEffect(() => {
    if (!ws) return;
    const onMessage = ({ data }) => {
      const msg = JSON.parse(data);
      if (msg.type === "video_signal") {
        if (msg.signalType === "video_offer") {
          setIncomingOffer(msg);
        } else {
          document.dispatchEvent(
            new CustomEvent("videoSignal", { detail: msg })
          );
        }
      }
    };
    ws.addEventListener("message", onMessage);
    return () => ws.removeEventListener("message", onMessage);
  }, [ws]);

  // ===== Common WebRTC signal handler (video_answer + ICE) =====
  useEffect(() => {
    const handler = async (e) => {
      const msg = e.detail;
      const pc = peerConnectionRef.current;
      if (!pc) return;

      if (msg.signalType === "video_answer") {
        // 1) Устанавливаем remoteDescription
        await pc.setRemoteDescription(new RTCSessionDescription(msg.answer));
        // 2) Настраиваем декодирование (до первого кадра)
        setupReceiverTransform(pc);
        // 3) Спускаем буферизированные ICE
        for (const cand of pendingCandidates.current) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(cand));
          } catch (err) {
            console.warn("Buffered ICE failed:", err);
          }
        }
        pendingCandidates.current = [];
        setCallStatus("in_call");
      } else if (msg.signalType === "ice_candidate") {
        if (pc.signalingState === "closed") return;
        // Буферизуем, если remoteDescription ещё не установлено
        if (!pc.remoteDescription || !pc.remoteDescription.type) {
          pendingCandidates.current.push(msg.candidate);
        } else {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
          } catch (err) {
            console.error("addIceCandidate error:", err);
          }
        }
      }
    };
    document.addEventListener("videoSignal", handler);
    return () => document.removeEventListener("videoSignal", handler);
  }, []);

  // ===== Accept / Reject =====
  const accept = () => {
    if (incomingOffer) handleOffer(incomingOffer);
    setIncomingOffer(null);
  };
  const reject = () => {
    setIncomingOffer(null);
    toast.info("Звонок отклонён");
  };

  // ===== Create & send offer =====
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

  // ===== Caller: startCall =====
  const startCall = async () => {
    if (!mediaKeyRef.current) {
      mediaKeyRef.current = await generateMediaKey();
      console.log("Media key generated");
    }
    const pc = new RTCPeerConnection(iceConfig);
    peerConnectionRef.current = pc;

    const stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    });
    stream.getTracks().forEach((t) => pc.addTrack(t, stream));
    setLocalStream(stream);
    localVideoRef.current.srcObject = stream;

    // Шифруем исходящий
    setupSenderTransform(pc);

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        ws.send(
          JSON.stringify({
            type: "video_signal",
            signalType: "ice_candidate",
            candidate,
            clientId,
            recipientId,
          })
        );
      }
    };

    // Просто показываем приходящий поток
    pc.ontrack = ({ streams: [s] }) => {
      setRemoteStream(s);
      remoteVideoRef.current.srcObject = s;
      remoteVideoRef.current.play().catch(() => {});
    };

    await makeOffer();
    setCallStatus("calling");
  };

  // ===== Callee: handleOffer =====
  const handleOffer = useCallback(
    async ({ offer }) => {
      if (!mediaKeyRef.current) {
        mediaKeyRef.current = await generateMediaKey();
        console.log("Media key generated");
      }
      const pc = new RTCPeerConnection(iceConfig);
      peerConnectionRef.current = pc;

      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      stream.getTracks().forEach((t) => pc.addTrack(t, stream));
      setLocalStream(stream);
      localVideoRef.current.srcObject = stream;

      setupSenderTransform(pc);

      pc.onicecandidate = ({ candidate }) => {
        if (candidate) {
          ws.send(
            JSON.stringify({
              type: "video_signal",
              signalType: "ice_candidate",
              candidate,
              clientId,
              recipientId,
            })
          );
        }
      };

      pc.ontrack = ({ streams: [s] }) => {
        setRemoteStream(s);
        remoteVideoRef.current.srcObject = s;
        remoteVideoRef.current.play().catch(() => {});
      };

      // 1) устанавливаем remoteDescription
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      // 2) настраиваем декодирование
      setupReceiverTransform(pc);
      // 3) сливаем буфер
      for (const cand of pendingCandidates.current) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(cand));
        } catch {}
      }
      pendingCandidates.current = [];
      // 4) создаём и шлём answer
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

  // ===== UI controls =====
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
    remoteStream?.getTracks().forEach((t) => t.stop());
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
