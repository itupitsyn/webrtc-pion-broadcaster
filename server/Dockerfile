FROM golang:1.23-alpine AS build

WORKDIR /src

# Dependencies first so a source-only change does not re-download the module graph.
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/sfu .

FROM gcr.io/distroless/static-debian12:nonroot

COPY --from=build /out/sfu /sfu

# 8080 is signaling and goes through the reverse proxy. The UDP port is media and
# must be published straight to the host: WebRTC does not pass through an HTTP proxy.
EXPOSE 8080
EXPOSE 7881/udp

USER nonroot:nonroot
ENTRYPOINT ["/sfu"]
