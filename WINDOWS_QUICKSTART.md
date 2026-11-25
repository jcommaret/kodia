# ⚡ QUICK START PARA WINDOWS - 9Router + Kodia

## 🎯 INSTRUCCIONES SIMPLIFICADAS PARA WINDOWS

---

## ⚠️ IMPORTANTE: Usa el proveedor existente

La forma MÁS FÁCIL de usar 9Router en Windows es **usar el proveedor "OpenAI-Compatible" que ya existe en Kodia**, en lugar de compilar.

---

## 🚀 OPCIÓN RECOMENDADA (Sin compilar)

### Paso 1: Instalar y ejecutar 9Router
```powershell
npm install -g 9router
9router
```
✅ Se abre en: http://localhost:20128

### Paso 2: Conectar proveedor gratuito en 9Router
1. Abrir: http://localhost:20128/dashboard
2. Ir a "Providers"
3. Clic en "Connect Kiro AI" (te da ~50 créditos/mes gratis)
4. Seguir los pasos

### Paso 3: Descargar Kodia compilado
Descarga la última versión compilada desde:
https://github.com/jcommaret/kodia/releases

O usa tu instalación actual de Kodia.

### Paso 4: Configurar en Kodia
1. Abrir Kodia
2. Presionar `Ctrl + ,` para Settings
3. Buscar "OpenAI-Compatible" (NO busques 9Router, usa este)
4. Configurar:
   ```
   baseURL: http://localhost:20128/v1
   API Key: [copiar desde 9Router dashboard]
   ```
5. Guardar

### Paso 5: Usar
1. Chat → Provider → "OpenAI-Compatible"
2. Model → Escribir manualmente: `kr/claude-sonnet-4.5`
3. ¡Usar!

---

## 🔧 OPCIÓN AVANZADA (Compilar con los cambios de 9Router nativo)

Solo si quieres compilar Kodia con 9Router como proveedor nativo:

### Problema en Windows:
- `npm run watch` usa bash (no disponible en Windows sin WSL)
- `npm install` puede tardar mucho

### Solución:

#### 1. Instalar dependencias (puede tardar 10-30 minutos)
```powershell
# Abrir PowerShell como administrador
cd l:\kodia
npm install
```
⏳ **PACIENCIA**: Esto TARDA MUCHO. Deja que termine.

#### 2. Compilar React UI
```powershell
npm run buildreact
```

#### 3. Usar el watcher de Windows
En lugar de `npm run watch`, usa:
```powershell
# Opción A: Watch del cliente (sin extensiones)
npm run watch-client

# Opción B: Watch solo para transpiling
npm run watch-client-transpile
```

#### 4. En otra terminal, ejecutar Kodia
```powershell
.\scripts\code.bat
```

---

## 🎯 MODELOS DISPONIBLES

Cuando uses el proveedor "OpenAI-Compatible" con 9Router:

### Gratuitos (Kiro AI):
```
kr/claude-sonnet-4.5
kr/glm-5
kr/minimax
```

### Gratuitos (OpenCode):
```
opencode/claude-sonnet-4.5
opencode/gpt-4
```

---

## 🆘 TROUBLESHOOTING WINDOWS

### ❌ "Cannot find package 'cross-spawn'"
**Solución**: Ejecuta `npm install` y espera a que termine (tarda mucho)

### ❌ "El subsistema de Windows para Linux no tiene distribuciones instaladas"
**Solución**: 
- **Opción 1 (Recomendada)**: Usa el proveedor "OpenAI-Compatible" (sin compilar)
- **Opción 2**: Usa `npm run watch-client` en lugar de `npm run watch`

### ❌ npm install se queda colgado
**Solución**: 
1. Presiona `Ctrl+C` para cancelar
2. Cierra todas las ventanas de Node/npm
3. Intenta de nuevo:
   ```powershell
   npm install --verbose
   ```

---

## ✅ RECOMENDACIÓN FINAL PARA WINDOWS

La forma más rápida y fácil:

1. **Usar Kodia instalado** (no compilar)
2. **Instalar 9Router**: `npm install -g 9router && 9router`
3. **Configurar en Kodia**: 
   - Provider: "OpenAI-Compatible"
   - baseURL: `http://localhost:20128/v1`
   - API Key: [desde 9Router dashboard]
4. **Listo!** ✅

---

## 📝 NOTAS IMPORTANTES

### Diferencia entre las opciones:

| Aspecto | OpenAI-Compatible | 9Router Nativo |
|---------|-------------------|----------------|
| Compilación | ❌ No necesaria | ✅ Necesaria |
| Funcionalidad | ✅ 100% funcional | ✅ 100% funcional |
| Configuración | Manual (baseURL) | Pre-configurado |
| Nombre en UI | "OpenAI-Compatible" | "9Router" |
| Modelos | Escribir manual | Lista automática |

**Resultado**: Exactamente igual, solo cambia la interfaz.

---

## 🎉 RESULTADO

Con cualquiera de las dos opciones tendrás:
- ✅ Acceso GRATIS a Claude Sonnet 4.5
- ✅ 40+ proveedores disponibles
- ✅ Ahorro de 20-40% en tokens
- ✅ Auto-fallback automático
- ✅ 100% funcional

---

## 🔗 RECURSOS

- **9Router GitHub**: https://github.com/decolua/9router
- **9Router Dashboard**: http://localhost:20128/dashboard
- **Kodia Releases**: https://github.com/jcommaret/kodia/releases

---

**Recomendación**: USA LA OPCIÓN FÁCIL (OpenAI-Compatible) 🎯
