# ⚡ QUICK START - 9Router + Kodia

## 🎯 Objetivo
Usar modelos de IA GRATIS en Kodia a través de 9Router

---

## ⏱️ Tiempo estimado: 10 minutos

---

## 📋 CHECKLIST RÁPIDO

```
[ ] Paso 1: Instalar 9Router
[ ] Paso 2: Conectar proveedor gratuito  
[ ] Paso 3: Compilar Kodia
[ ] Paso 4: Configurar en Kodia
[ ] Paso 5: Usar y disfrutar
```

---

## 🚀 COMANDOS EXACTOS

### Terminal 1: 9Router
```bash
npm install -g 9router
9router
```
✅ Debe abrir: http://localhost:20128

### Terminal 2: Compilar Kodia
```bash
cd l:\kodia
npm run buildreact
npm run watch
```
✅ Esperar a ver: "Finished compilation"

### Terminal 3: Ejecutar Kodia
```bash
cd l:\kodia
./scripts/code.sh      # Mac/Linux
# o
./scripts/code.bat     # Windows
```
✅ Debe abrir Kodia

---

## 🌐 CONFIGURACIÓN EN 9ROUTER

1. Abrir: http://localhost:20128/dashboard
2. Clic en: **"Providers"** (menú izquierdo)
3. Buscar: **"Kiro AI"**
4. Clic en: **"Connect"**
5. Seguir los pasos (muy simple)
6. ✅ Ahora tienes ~50 créditos/mes GRATIS

---

## ⚙️ CONFIGURACIÓN EN KODIA

### 1. Abrir Settings
- **Windows/Linux**: `Ctrl + ,`
- **Mac**: `Cmd + ,`

### 2. Buscar Providers
- En la barra de búsqueda: "providers"
- O navegar a: Settings → Extensions → Providers

### 3. Encontrar 9Router
- Scroll hacia abajo
- Buscar: **"9Router"**
- Debe tener el icono y descripción

### 4. Configurar
```
Endpoint: http://localhost:20128
          (ya debe estar configurado)

API Key: [copiar desde 9Router dashboard]
```

**Cómo copiar API Key:**
1. Ir a: http://localhost:20128/dashboard
2. Buscar sección: "API Keys" o "Settings"
3. Copiar la key
4. Pegar en Kodia

### 5. Guardar
- Clic en botón "Save" o simplemente cerrar Settings

---

## 🎨 SELECCIONAR MODELO

### Para Chat:
1. Settings → Features → Chat
2. Provider: **9Router**
3. Model: **kr/claude-sonnet-4.5**

### Para Apply:
1. Settings → Features → Apply
2. Provider: **9Router**
3. Model: **kr/claude-sonnet-4.5**

### Para Ctrl+K:
1. Settings → Features → Ctrl+K
2. Provider: **9Router**
3. Model: **kr/claude-sonnet-4.5**

### Para Autocomplete:
1. Settings → Features → Autocomplete
2. Provider: **9Router**
3. Model: Seleccionar uno con FIM support
   - Ejemplo: `kr/glm-5` o similar

---

## ✅ VERIFICACIÓN

### 1. Verificar que 9Router corre
```bash
# En navegador abrir:
http://localhost:20128
```
✅ Debe mostrar el dashboard

### 2. Verificar que Kodia tiene 9Router
```bash
# En Kodia:
1. Cmd+, (o Ctrl+,)
2. Buscar "9Router"
3. Debe aparecer en la lista
```

### 3. Probar el chat
```
1. Abrir sidebar de chat en Kodia
2. Escribir: "Hola, ¿funciona 9Router?"
3. Debe responder normalmente
```

---

## 🔥 MODELOS RECOMENDADOS

### Para coding (mejor calidad):
```
kr/claude-sonnet-4.5
```

### Para coding (más rápido):
```
kr/glm-5
```

### Para uso general (sin límites):
```
opencode/claude-sonnet-4.5
```

---

## 🆘 TROUBLESHOOTING RÁPIDO

### ❌ "ECONNREFUSED" o "Connection refused"
**Causa**: 9Router no está corriendo
**Fix**:
```bash
9router
```

### ❌ "Invalid API Key"
**Causa**: API key incorrecta o no configurada
**Fix**:
1. http://localhost:20128/dashboard
2. Copiar API key
3. Pegar en Kodia Settings

### ❌ "No models available"
**Causa**: 9Router no tiene proveedores
**Fix**:
1. http://localhost:20128/dashboard
2. Providers → Connect Kiro AI
3. Reiniciar Kodia (Cmd+Q o Alt+F4, luego abrir de nuevo)

### ❌ Kodia no muestra 9Router en providers
**Causa**: No recompilaste
**Fix**:
```bash
npm run buildreact
npm run watch
# Reiniciar Kodia
```

---

## 📊 DASHBOARD DE 9ROUTER

### Ver estadísticas:
```
http://localhost:20128/dashboard
```

### Qué puedes ver:
- ✅ Tokens usados
- ✅ Modelos más usados
- ✅ Proveedores activos
- ✅ Créditos restantes
- ✅ Logs de requests

---

## 🎓 CARACTERÍSTICAS PROBADAS

Después de configurar, puedes usar:

| Característica | Comando | Estado |
|----------------|---------|--------|
| Chat básico | Sidebar → Chat | ✅ |
| Apply código | Cmd+Shift+Enter | ✅ |
| Ctrl+K editar | Ctrl+K | ✅ |
| Autocomplete | Escribir código | ✅ |
| Tools | Automático | ✅ |

---

## 🎯 TIPS FINALES

### 1. Mantén 9Router corriendo
```bash
# En una terminal siempre activa:
9router
```

### 2. Monitorea tu uso
```
http://localhost:20128/dashboard
```

### 3. Si un proveedor falla
- 9Router cambia automáticamente
- No necesitas hacer nada

### 4. Ahorro de tokens
- 9Router comprime automáticamente
- Ahorras 20-40% sin hacer nada

### 5. Múltiples proveedores
- Puedes conectar varios en 9Router
- Auto-fallback entre todos

---

## 🏆 CHECKLIST FINAL

```
✅ 9Router instalado y corriendo
✅ Proveedor gratuito conectado (Kiro AI)
✅ Kodia compilado y ejecutándose
✅ 9Router configurado en Kodia Settings
✅ Modelo seleccionado
✅ Probado en chat
✅ Todo funciona
```

---

## 📚 MÁS INFORMACIÓN

- **Guía completa**: `README_9ROUTER_ES.md`
- **Documentación técnica**: `INTEGRATION_9ROUTER.md`
- **Verificación**: `./verify-9router-integration.ps1`
- **Resumen**: `RESUMEN_FINAL.md`

---

## 🎉 ¡LISTO!

Ya tienes:
- ✅ Acceso GRATIS a Claude Sonnet 4.5
- ✅ Sin límites (con auto-fallback)
- ✅ Ahorro automático de tokens
- ✅ 40+ modelos disponibles

**¡A programar!** 🚀

---

**Tiempo real**: ~10 minutos  
**Dificultad**: Fácil  
**Resultado**: Acceso ilimitado a IA  
**Costo**: $0 GRATIS
