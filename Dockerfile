# Use Node.js LTS as the base image
FROM node:18-alpine

# Set the working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY evm-decoder-service.js ./

# Create directory for ABIs
RUN mkdir -p /app/abis

COPY abis/* /app/abis

# Start the service
CMD ["node", "evm-decoder-service.js"]
