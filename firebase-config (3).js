// ==========================================================
// firebase-config.js — Portal Imperial (Comida China)
// Floridablanca, Colombia · WALLACE COMPANY SYSTEM
// ==========================================================
//
//  >>> PLANTILLA — REEMPLAZA CON LAS CREDENCIALES REALES <<<
//
//  Cómo obtener estas credenciales (5 minutos):
//  1. Entra a  https://console.firebase.google.com
//  2. Clic en "Agregar proyecto" -> nombre: portal-imperial -> Crear.
//  3. En el menú izquierdo: Compilación (Build) -> Realtime Database
//       -> "Crear base de datos" -> ubicación EE.UU. -> "Modo de prueba".
//  4. Rueda de engranaje (arriba izq.) -> "Configuración del proyecto".
//  5. Baja hasta "Tus apps" -> ícono </> (Web) -> registra la app.
//  6. Firebase te muestra un objeto "firebaseConfig". COPIA sus valores
//     y pégalos abajo, reemplazando los "PEGA_AQUI_...".
//  7. Guarda, sube a GitHub (git add/commit/push) y recarga con Ctrl+Shift+R.
//
//  IMPORTANTE: databaseURL debe terminar en  -default-rtdb.firebaseio.com
//  Si tu región es Europa/otra, Firebase te dará la URL correcta; úsala tal cual.
// ==========================================================

window.FIREBASE_CONFIG = {
  apiKey:            "PEGA_AQUI_TU_API_KEY",
  authDomain:        "portal-imperial.firebaseapp.com",
  databaseURL:       "https://portal-imperial-default-rtdb.firebaseio.com",
  projectId:         "portal-imperial",
  storageBucket:     "portal-imperial.firebasestorage.app",
  messagingSenderId: "PEGA_AQUI_TU_SENDER_ID",
  appId:             "PEGA_AQUI_TU_APP_ID"
};

// Zona horaria del negocio (Colombia = -5). El sistema guarda en UTC y
// convierte a esta hora local SOLO al mostrar (ver Parte 6.5, error 1).
window.TZ_OFFSET_HORAS = -5;
