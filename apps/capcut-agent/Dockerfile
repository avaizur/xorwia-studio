# 1. Base Image: Use the official AWS Lambda Node.js 20 Linux image
FROM public.ecr.aws/lambda/nodejs:20

# 2. Install low-level dependencies for yt-dlp & ffmpeg networking
RUN dnf update -y && \
    dnf install -y python3 python3-pip curl tar xz && \
    dnf clean all

# 3. Download the latest yt-dlp binary safely directly into the Lambda path
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp

# 4. Download and setup the static build of FFmpeg (Bypasses Amazon Linux repository limits securely)
RUN curl -L https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz | tar -xJ && \
    mv ffmpeg-*-amd64-static/ffmpeg /usr/local/bin/ && \
    mv ffmpeg-*-amd64-static/ffprobe /usr/local/bin/ && \
    rm -rf ffmpeg-*-amd64-static

# 5. Copy your application configuration and install dependencies
COPY package.json package-lock.json ./
RUN npm install --production

# 6. Copy the rest of the agent codebase
COPY . .

# 7. Start the Lambda handler securely (using the serverless-http wrapper we added)
CMD [ "server.handler" ]
