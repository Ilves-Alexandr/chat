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
  const initializedReceiversRef = useRef(new WeakSet());

  // ============ Sender transform ============
  const setupSenderTransform = (sender) => {
    if (!mediaKeyRef.current) {
      console.warn("⚠️ Sender transform skipped: key not ready yet");
      return;
    }
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
    if (!mediaKeyRef.current) {
      console.warn("⚠️ Receiver transform skipped: key not ready yet");
      return;
    }
    if (initializedReceiversRef.current.has(receiver)) {
      console.log("⏭ Receiver already initialized:", receiver.track.id);
      return;
    }

    if (!receiver.createEncodedStreams || receiver.track.kind !== "video") {
      console.log("— skipping transform, not a video receiver");
      initializedReceiversRef.current.add(receiver);
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
      initializedReceiversRef.current.add(receiver);
      return;
    }
    initializedReceiversRef.current.add(receiver);
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
    (async () => {
      mediaKeyRef.current = await generateMediaKey();
      console.log("🔑 MediaKey ready");
    })();
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
    pc.addTransceiver("video", { direction: "recvonly" });
    pc.addTransceiver("audio", { direction: "recvonly" });
    const offer = await pc.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: true
    });
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
  const makeAnswer = useCallback(
    async (pc, incomingOffer) => {
      // Создаём ответ
      const answer = await pc.createAnswer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true,
      });
      // Устанавливаем локальное описание
      await pc.setLocalDescription(answer);
      console.log("🔄 [makeAnswer] local SDP:", pc.localDescription.sdp);
      // Отправляем его по WS
      ws.send(
        JSON.stringify({
          type: "video_signal",
          signalType: "video_answer",
          answer: pc.localDescription,
          clientId,
          recipientId,
        })
      );
    },
    [ws, clientId, recipientId]
  );
  
  // ============ Initiator ============
  const startCall = async () => {
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
      console.log("📥 ontrack:", e.receiver.track.kind, e.streams);
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
      // 1) создаём RTCPeerConnection
      const pc = new RTCPeerConnection(iceConfig);
      pcRef.current = pc;

      // 2) получаем камеру/микрофон **ЕЩЁ до** setRemoteDescription
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      setLocalStream(stream);
      localVideoRef.current.srcObject = stream;

      // 3) добавляем реальные треки к соединению (по одному addTrack() на каждый)
      stream.getTracks().forEach((track) => {
        const sender = pc.addTrack(track, stream);
        setupSenderTransform(sender);
      });

      // 4) сигналим свои ICE-кандидаты
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

      // 5) вешаем ontrack — сюда придут remote-потоки от того, кто звонил
      pc.ontrack = (e) => {
        console.log(
          "📥 ontrack:",
          e.receiver.track.kind,
          "streams:",
          e.streams
        );
        const [remote] = e.streams;
        setRemoteStream(remote);
        remoteVideoRef.current.srcObject = remote;
        remoteVideoRef.current.play().catch(() => {});
      };

      // 6) теперь принимаем SDP-оффер
      console.log("🔄 [handleOffer] setting remote description");
      await pc.setRemoteDescription(new RTCSessionDescription(d.offer));

      // 7) и только теперь создаём ответ
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      console.log(
        "🔄 [handleOffer] local SDP answer:",
        pc.localDescription.sdp
      );

      // 8) шлём его обратно
      ws.send(
        JSON.stringify({
          type: "video_signal",
          signalType: "video_answer",
          answer: pc.localDescription,
          clientId,
          recipientId,
        })
      );
      await makeAnswer(pc, d.offer);
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
    initializedReceiversRef.current = new WeakSet();
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
