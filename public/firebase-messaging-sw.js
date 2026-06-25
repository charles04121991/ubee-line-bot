importScripts("https://www.gstatic.com/firebasejs/10.12.5/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.5/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyCNuP9x_GWDjmJx0-xyO316fa6jiFSfa-s",
  authDomain: "ubee-oms.firebaseapp.com",
  projectId: "ubee-oms",
  messagingSenderId: "1034403762695",
  appId: "1:1034403762695:web:c1797a7e9e47ed566c10a2"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage(function(payload){
  console.log("UBee 背景派單通知：", payload);

  const payloadData = payload.data || {};

  const title =
    payload.notification?.title ||
    payloadData.title ||
    "UBee 新任務";

  const body =
    payload.notification?.body ||
    payloadData.body ||
    "附近有新的跑腿任務，請立即查看。";

  const options = {
    body,
    icon: "/ubee-rider-icon.png?v=1",
    badge: "/ubee-rider-icon.png?v=1",
    data: {
      ...payloadData,
      url: payloadData.url || "/rider.html"
    },
    requireInteraction: true,
    vibrate: [500, 300, 500]
  };

  self.registration.showNotification(title, options);
});

self.addEventListener("notificationclick", function(event){
  event.notification.close();

  const targetUrl =
    event.notification?.data?.url ||
    "/rider.html";

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(function(clientList){
      for(const client of clientList){
        if(client.url.includes("/rider.html") && "focus" in client){
          return client.focus();
        }
      }

      return clients.openWindow(targetUrl);
    })
  );
});
