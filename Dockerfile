# CineHall Custom Image for OpenShift
# Base: UBI 9 minimal (Red Hat Universal Base Image) - non-root compatible
FROM registry.access.redhat.com/ubi9/ubi-minimal:9.5

# Install Node.js 20 from NodeSource, yt-dlp, ffmpeg, python3
# Use rpm to remove curl-minimal, then install curl in same RUN
# Install ffmpeg from RPM Fusion (not available in UBI base repos)
RUN rpm -e --nodeps curl-minimal && \
    microdnf install -y curl python3 python3-pip shadow-utils && \
    microdnf clean all && \
    rm -rf /var/cache/yum && \
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - && \
    microdnf install -y nodejs && \
    microdnf install -y https://mirrors.rpmfusion.org/free/el/rpmfusion-free-release-9.noarch.rpm https://mirrors.rpmfusion.org/nonfree/el/rpmfusion-nonfree-release-9.noarch.rpm && \
    microdnf install -y ffmpeg && \
    microdnf clean all && \
    rm -rf /var/cache/yum

# Install yt-dlp via pip (latest version)
RUN pip3 install --no-cache-dir --break-system-packages yt-dlp

# Create non-root user (UID 1001) for OpenShift restricted-v2 SCC
RUN useradd -u 1001 -r -g 0 -d /opt/app -s /sbin/nologin -c "CineHall App User" appuser && \
    mkdir -p /opt/app && \
    chown -R 1001:0 /opt/app

WORKDIR /opt/app

# Copy package files first (for layer caching)
COPY --chown=1001:0 package*.json ./

# Install npm dependencies
RUN npm ci --only=production 2>/dev/null || npm install --only=production

# Copy application source code
COPY --chown=1001:0 . ./

# Create data/cache directories with correct permissions
RUN mkdir -p /opt/app/data/cache && \
    chown -R 1001:0 /opt/app/data && \
    chmod -R 775 /opt/app/data

# Switch to non-root user
USER 1001

# Expose port 8080 (OpenShift default)
EXPOSE 8080

# Environment variables
ENV PORT=8080
ENV NODE_ENV=production

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:8080/api/health || exit 1

# Start the server
CMD ["node", "server.js"]