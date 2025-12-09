# Usa una imagen base de Node.js
FROM node:20-alpine

# Establece el directorio de trabajo
WORKDIR /app

# Copia los archivos de dependencias
COPY package*.json ./

# Instala las dependencias
RUN npm ci --only=production

# Copia el resto del código
COPY . .

# Expone el puerto (ajusta según tu configuración)
EXPOSE 3000

# Comando para iniciar la aplicación
CMD ["npm", "start"]
