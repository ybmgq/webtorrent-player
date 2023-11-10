/* global MediaMetadata, navNowPlaying */
import WebTorrent from 'webtorrent'
import { SubtitleParser, SubtitleStream } from 'matroska-subtitles'
import HybridChunkStore from 'hybrid-chunk-store'
import SubtitlesOctopus from './lib/subtitles-octopus.js'
import Peer from './lib/peer.js'

const units = [' B', ' KB', ' MB', ' GB', ' TB']

function requestTimeout (callback, delay) {
  const startedAt = Date.now()
  let animationFrame = requestAnimationFrame(tick)
  function tick () {
    if (Date.now() - startedAt >= delay) {
      callback()
    } else {
      animationFrame = requestAnimationFrame(tick)
    }
  }
  return {
    clear: () => cancelAnimationFrame(animationFrame)
  }
}

function cancelTimeout (timeout) {
  if (timeout) {
    timeout.clear()
  }
}

export default class WebTorrentPlayer extends WebTorrent {
  constructor (options = {}) {
    super(options.WebTorrentOpts)

    this.storeOpts = options.storeOpts || {}

    const scope = location.pathname.substr(0, location.pathname.lastIndexOf('/') + 1)
    const worker = location.origin + scope + 'sw.js' === navigator.serviceWorker?.controller?.scriptURL && navigator.serviceWorker.controller
    const handleWorker = worker => {
      const checkState = worker => {
        return worker.state === 'activated' && this.loadWorker(worker)
      }
      if (!checkState(worker)) {
        worker.addEventListener('statechange', ({ target }) => checkState(target))
      }
    }
    if (worker) {
      handleWorker(worker)
    } else {
      navigator.serviceWorker.register('sw.js', { scope }).then(reg => {
        handleWorker(reg.active || reg.waiting || reg.installing)
      }).catch(e => {
        if (String(e) === 'InvalidStateError: Failed to register a ServiceWorker: The document is in an invalid state.') {
          location.reload() // weird workaround for a weird bug
        } else {
          throw e
        }
      })
    }
    window.addEventListener('beforeunload', () => {
      this.destroy()
      this.cleanupVideo()
    })

    this.video = options.video
    this.controls = options.controls || {} // object of controls
    // playPause, playNext, playLast, openPlaylist, toggleMute, setVolume, setProgress, selectCaptions, selectAudio, toggleTheatre, toggleFullscreen, togglePopout, forward, rewind

    if (this.controls.setVolume) {
      this.controls.setVolume.addEventListener('input', e => this.setVolume(e.target.value))
      this.setVolume()
      this.oldVolume = undefined
      if ('audioTracks' in HTMLVideoElement.prototype && this.controls.audioButton) {
        this.video.addEventListener('loadedmetadata', () => {
          if (this.video.audioTracks.length > 1) {
            this.controls.audioButton.removeAttribute('disabled')
            for (const track of this.video.audioTracks) {
              this.createRadioElement(track, 'audio')
            }
          } else {
            this.controls.audioButton.setAttribute('disabled', '')
          }
        })
      }
    }
    if (this.controls.ppToggle) {
      this.controls.ppToggle.addEventListener('click', () => this.playPause())
      this.controls.ppToggle.addEventListener('dblclick', () => this.toggleFullscreen())
    }

    if (this.controls.setProgress) {
      this.controls.setProgress.addEventListener('input', e => this.setProgress(e.target.value))
      this.controls.setProgress.addEventListener('mouseup', e => this.dragBarEnd(e.target.value))
      this.controls.setProgress.addEventListener('touchend', e => this.dragBarEnd(e.target.value))
      this.controls.setProgress.addEventListener('mousedown', e => this.dragBarStart(e.target.value))
      this.video.addEventListener('timeupdate', e => {
        if (this.immerseTimeout && document.location.hash === '#player' && !this.video.paused) this.setProgress(e.target.currentTime / e.target.duration * 100)
      })
      this.video.addEventListener('ended', () => this.setProgress(100))
    }

    this.video.addEventListener('loadedmetadata', () => this.findSubtitleFiles(this.currentFile))
    this.subtitleData = {
      fonts: [],
      headers: [],
      tracks: [],
      current: undefined,
      renderer: undefined,
      stream: undefined,
      parser: undefined,
      parsed: undefined,
      timeout: undefined,
      defaultHeader: `[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${options.defaultSSAStyles || 'Roboto Medium,26,&H00FFFFFF,&H000000FF,&H00020713,&H00000000,0,0,0,0,100,100,0,0,1,1.3,0,2,20,20,23,1'}
[Events]

`
    }

    this.completed = false
    this.video.addEventListener('timeupdate', () => this.checkCompletion())

    this.nextTimeout = undefined
    if (options.autoNext) this.video.addEventListener('ended', () => this.playNext())

    this.resolveFileMedia = options.resolveFileMedia
    this.currentFile = undefined
    this.videoFile = undefined

    if (this.controls.thumbnail) {
      this.generateThumbnails = options.generateThumbnails
      const thumbCanvas = document.createElement('canvas')
      thumbCanvas.width = options.thumbnailWidth || 150
      this.thumbnailData = {
        thumbnails: [],
        canvas: thumbCanvas,
        context: thumbCanvas.getContext('2d'),
        interval: undefined,
        video: undefined
      }
      this.video.addEventListener('loadedmetadata', () => this.initThumbnail())
      this.video.addEventListener('timeupdate', () => this.createThumbnail(this.video))
    }

    if (options.visibilityLossPause) {
      this.wasPaused = true
      document.addEventListener('visibilitychange', () => {
        if (!this.video.ended) {
          if (document.visibilityState === 'hidden') {
            this.wasPaused = this.video.paused
            this.video.pause()
          } else {
            if (!this.wasPaused) this.playPause()
          }
        }
      })
    }

    this.onDone = undefined

    this.destroyStore = options.destroyStore != null ? !!options.destroyStore : true

    this.immerseTimeout = undefined
    this.immerseTime = options.immerseTime || 5

    this.playerWrapper = options.playerWrapper
    this.player = options.player
    if (this.player) {
      this.player.addEventListener('fullscreenchange', () => this.updateFullscreen())
      this.player.addEventListener('mousemove', () => requestAnimationFrame(() => this.resetImmerse()))
      this.player.addEventListener('touchmove', () => requestAnimationFrame(() => this.resetImmerse()))
      this.player.addEventListener('keypress', () => requestAnimationFrame(() => this.resetImmerse()))
      this.player.addEventListener('mouseleave', () => requestAnimationFrame(() => this.immersePlayer()))

      this.doubleTapTimeout = undefined
      this.player.addEventListener('touchend', e => {
        if (this.doubleTapTimeout) {
          e.preventDefault()
          clearTimeout(this.doubleTapTimeout)
          this.doubleTapTimeout = undefined
          this.toggleFullscreen()
        } else {
          this.doubleTapTimeout = setTimeout(() => {
            this.doubleTapTimeout = undefined
          }, 200)
        }
      })
    }

    this.bufferTimeout = undefined
    this.video.addEventListener('playing', () => this.hideBuffering())
    this.video.addEventListener('canplay', () => this.hideBuffering())
    this.video.addEventListener('loadeddata', () => this.hideBuffering())
    this.video.addEventListener('waiting', () => this.showBuffering())

    const handleAvailability = aval => {
      if (aval) {
        this.controls.toggleCast.removeAttribute('disabled')
      } else {
        this.controls.toggleCast.setAttribute('disabled', '')
      }
    }
    if ('PresentationRequest' in window) {
      this.presentationRequest = new PresentationRequest(['lib/cast.html'])
      this.presentationRequest.addEventListener('connectionavailable', e => this.initCast(e))
      this.presentationConnection = null
      navigator.presentation.defaultRequest = this.presentationRequest
      this.presentationRequest.getAvailability().then(aval => {
        aval.onchange = e => handleAvailability(e.target.value)
        handleAvailability(aval.value)
      })
    } else {
      this.controls.toggleCast.setAttribute('disabled', '')
    }

    if ('pictureInPictureEnabled' in document) {
      this.burnIn = options.burnIn
      if (this.controls.togglePopout) this.controls.togglePopout.removeAttribute('disabled')
      if (this.burnIn) this.video.addEventListener('enterpictureinpicture', () => { if (this.subtitleData.renderer) this.togglePopout() })
    } else {
      this.video.setAttribute('disablePictureInPicture', '')
      if (this.controls.togglePopout) this.controls.togglePopout.setAttribute('disabled', '')
    }

    this.seekTime = options.seekTime || 5
    if ('mediaSession' in navigator) {
      navigator.mediaSession.setActionHandler('play', () => this.playPause())
      navigator.mediaSession.setActionHandler('pause', () => this.playPause())
      navigator.mediaSession.setActionHandler('seekbackward', () => this.seek(this.seekTime))
      navigator.mediaSession.setActionHandler('seekforward', () => this.seek(this.seekTime))
      navigator.mediaSession.setActionHandler('nexttrack', () => this.playNext())
      if ('setPositionState' in navigator.mediaSession) this.video.addEventListener('timeupdate', () => this.updatePositionState())
    }

    this.subtitleExtensions = ['.srt', '.vtt', '.ass', '.ssa']
    this.videoExtensions = ['.3g2', '.3gp', '.asf', '.avi', '.dv', '.flv', '.gxf', '.m2ts', '.m4a', '.m4b', '.m4p', '.m4r', '.m4v', '.mkv', '.mov', '.mp4', '.mpd', '.mpeg', '.mpg', '.mxf', '.nut', '.ogm', '.ogv', '.swf', '.ts', '.vob', '.webm', '.wmv', '.wtv']
    this.videoFiles = undefined

    this.updateDisplay()
    this.offlineTorrents = JSON.parse(localStorage.getItem('offlineTorrents')) || {}
    // adds all offline store torrents to the client
    Object.values(this.offlineTorrents).forEach(torrentID => this.offlineDownload(new Blob([new Uint8Array(torrentID)])))

    this.streamedDownload = options.streamedDownload

    this.fps = 23.976
    if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
      this.video.addEventListener('loadeddata', () => {
        this.fps = new Promise(resolve => {
          let lastmeta = null
          let waspaused = false
          let count = 0

          const handleFrames = (now, metadata) => {
            if (count) { // resolve on 2nd frame, 1st frame might be a cut-off
              if (lastmeta) {
                const msbf = (metadata.mediaTime - lastmeta.mediaTime) / (metadata.presentedFrames - lastmeta.presentedFrames)
                const rawFPS = (1 / msbf).toFixed(3)
                // this is accurate for mp4, mkv is a few ms off
                if (this.currentFile.name.endsWith('.mkv')) {
                  if (rawFPS < 25 && rawFPS > 22) {
                    resolve(23.976)
                  } else if (rawFPS < 31 && rawFPS > 28) {
                    resolve(29.97)
                  } else if (rawFPS < 62 && rawFPS > 58) {
                    resolve(59.94)
                  } else {
                    resolve(rawFPS) // smth went VERY wrong
                  }
                } else {
                  resolve(rawFPS)
                }
                if (waspaused) this.video.pause()
              } else {
                lastmeta = metadata
                this.video.requestVideoFrameCallback(handleFrames)
              }
            } else {
              count++
              if (this.video.paused) {
                waspaused = true
                this.video.play()
              }
              this.video.requestVideoFrameCallback(handleFrames)
            }
          }
          this.video.requestVideoFrameCallback(handleFrames)
        })
      })
    }

    for (const [functionName, elements] of Object.entries(this.controls)) {
      if (this[functionName]) {
        if (elements.constructor === Array) {
          for (const element of elements) {
            element.addEventListener('click', e => {
              this[functionName](e.target.value)
            })
          }
        } else {
          elements.addEventListener('click', e => {
            this[functionName](e.target.value)
          })
        }
      }
    }
    document.addEventListener('keydown', a => {
      if (a.key === 'F5') {
        a.preventDefault()
      }
      if (location.hash === '#player') {
        switch (a.key) {
          case ' ':
            this.playPause()
            break
          case 'n':
            this.playNext()
            break
          case 'm':
            this.toggleMute()
            break
          case 'p':
            this.togglePopout()
            break
          case 't':
            this.toggleTheatre()
            break
          case 'c':
            this.captions()
            break
          case 'f':
            this.toggleFullscreen()
            break
          case 's':
            this.seek(85)
            break
          case 'ArrowLeft':
            this.seek(-this.seekTime)
            break
          case 'ArrowRight':
            this.seek(this.seekTime)
            break
          case 'ArrowUp':
            this.setVolume(Number(this.controls.setVolume.value) + 5)
            break
          case 'ArrowDown':
            this.setVolume(Number(this.controls.setVolume.value) - 5)
            break
          case 'Escape':
            location.hash = '#home'
            break
        }
      }
    })
  }

  async buildVideo (torrent, opts = {}) { // sets video source and creates a bunch of other media stuff
    // play wanted episode from opts, or the 1st episode, or 1st file [batches: plays wanted episode, single: plays the only episode, manually added: plays first or only file]
    this.cleanupVideo()
    if (opts.file) {
      this.currentFile = opts.file
    } else if (this.videoFiles.length > 1) {
      this.currentFile = this.videoFiles.filter(async file => await this.resolveFileMedia({ fileName: file.name }).then(FileMedia => (Number(FileMedia.episodeNumber) === Number(opts.episode || 1)) || (FileMedia === opts.media)))[0] || this.videoFiles[0]
    } else {
      this.currentFile = this.videoFiles[0]
    }
    // opts.media: mediaTitle, episodeNumber, episodeTitle, episodeThumbnail, mediaCover, name
    this.nowPlaying = (opts.media && (this.videoFiles.length === 1 || (opts.forceMedia && opts.file))) ? opts.media : this.resolveFileMedia ? await this.resolveFileMedia({ fileName: this.currentFile.name, method: 'SearchName' }) : undefined

    if (this.nowPlaying) {
      if (navNowPlaying) navNowPlaying.classList.remove('d-none')

      const episodeInfo = [this.nowPlaying.episodeNumber, this.nowPlaying.episodeTitle].filter(s => s).join(' - ')

      if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: this.nowPlaying.mediaTitle || this.nowPlaying.name || 'WebTorrentPlayer',
          artist: 'Episode ' + episodeInfo,
          album: this.nowPlaying.name || 'WebTorrentPlayer',
          artwork: [{
            src: this.nowPlaying.episodeThumbnail || this.nowPlaying.mediaCover || '',
            sizes: '256x256',
            type: 'image/jpg'
          }]
        })
      }
      if (this.nowPlaying.episodeThumbnail) this.video.poster = this.nowPlaying.episodeThumbnail

      this.changeControlsIcon('nowPlaying', 'EP ' + episodeInfo)
      document.title = [this.nowPlaying.mediaTitle, episodeInfo ? 'EP ' + episodeInfo : false, this.nowPlaying.name || 'WebTorrentPlayer'].filter(s => s).join(' - ')
    }
    if (this.currentFile.name.endsWith('mkv')) {
      let initStream = null
      this.currentFile.on('stream', ({ stream }) => {
        initStream = stream
      })
      this.initParser(this.currentFile).then(() => {
        this.currentFile.on('stream', ({ stream, req }, cb) => {
          if (req.destination === 'video' && !this.subtitleData.parsed) {
            this.subtitleData.stream = new SubtitleStream(this.subtitleData.stream)
            this.handleSubtitleParser(this.subtitleData.stream, true)
            stream.pipe(this.subtitleData.stream)
            cb(this.subtitleData.stream)
          }
        })
        initStream?.destroy()
      })
    }
    await navigator.serviceWorker.ready
    if (this.currentFile.done) {
      this.postDownload()
    } else {
      this.onDone = this.currentFile.on('done', () => this.postDownload())
    }

    this.currentFile.streamTo(this.video)
    this.video.load()
    this.playVideo()

    if (this.controls.downloadFile) {
      this.currentFile.getStreamURL((_err, url) => {
        this.controls.downloadFile.href = url
      })
    }
  }

  cleanupVideo () { // cleans up objects, attemps to clear as much video caching as possible
    this.presentationConnection?.terminate()
    if (document.pictureInPictureElement) document.exitPictureInPicture()
    this.subtitleData.renderer?.destroy()
    this.subtitleData.parser?.destroy()
    this.subtitleData.stream?.destroy()
    this.subtitleData.fonts?.forEach(file => URL.revokeObjectURL(file)) // ideally this should clean up after its been downloaded by the sw renderer, but oh well
    if (this.controls.downloadFile) this.controls.downloadFile.href = ''
    this.currentFile = undefined
    this.video.poster = ''
    // some attemt at cache clearing
    this.video.pause()
    this.video.src = ''
    this.video.load()
    this.onDone = undefined
    document.title = this.nowPlaying?.name || 'WebTorrentPlayer'
    this.setProgress(0)
    // look for file and delete its store, idk how to do this
    Object.assign(this.subtitleData, {
      fonts: [],
      headers: [],
      tracks: [],
      current: undefined,
      renderer: undefined,
      stream: undefined,
      parser: undefined,
      parsed: undefined,
      timeout: undefined
    })

    if (this.controls.thumbnail) {
      Object.assign(this.thumbnailData, {
        thumbnails: [],
        interval: undefined,
        video: undefined
      })
    }
    this.completed = false
    this.changeControlsIcon('nowPlaying', '')
    if (this.controls.captionsButton) this.controls.captionsButton.setAttribute('disabled', '')
    this.changeControlsIcon('selectCaptions', '')
    this.changeControlsIcon('selectAudio', '')
    if (this.controls.openPlaylist) this.controls.openPlaylist.setAttribute('disabled', '')
    if (navNowPlaying) navNowPlaying.classList.add('d-none')
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = undefined
    this.fps = 23.976
  }

  changeControlsIcon (type, text) {
    if (this.controls[type]) {
      if (this.controls[type].constructor === Array) {
        for (const element of this.controls[type]) {
          element.textContent = text
        }
      } else {
        this.controls[type].textContent = text
      }
    }
  }

  async playVideo () {
    try {
      await this.video.play()
      this.changeControlsIcon('playPause', 'pause')
    } catch (err) {
      this.changeControlsIcon('playPause', 'play_arrow')
    }
  }

  playPause () {
    if (this.video.paused) {
      this.playVideo()
    } else {
      this.changeControlsIcon('playPause', 'play_arrow')
      this.video.pause()
    }
  }

  setVolume (volume) {
    const level = volume === undefined ? Number(this.controls.setVolume.value) : volume
    this.controls.setVolume.value = level
    this.controls.setVolume.style.setProperty('--volume-level', level + '%')
    this.changeControlsIcon('toggleMute', level === 0 ? 'volume_off' : 'volume_up')
    this.video.volume = level / 100
  }

  toggleMute () {
    if (this.video.volume === 0) {
      this.setVolume(this.oldVolume)
    } else {
      this.oldVolume = this.video.volume * 100
      this.setVolume(0)
    }
  }

  toggleTheatre () {
    this.playerWrapper.classList.toggle('nav-hidden')
  }

  toggleFullscreen () {
    document.fullscreenElement ? document.exitFullscreen() : this.player.requestFullscreen()
  }

  updateFullscreen () {
    this.changeControlsIcon('toggleFullscreen', document.fullscreenElement ? 'fullscreen_exit' : 'fullscreen')
  }

  openPlaylist () {
    this.emit('playlist', { files: this.videoFiles })
  }

  playNext () {
    clearTimeout(this.nextTimeout)
    this.nextTimeout = setTimeout(() => {
      if (this.videoFiles?.indexOf(this.currentFile) < this.videoFiles?.length - 1) {
        const nowPlaying = this.nowPlaying
        nowPlaying.episodeNumber += 1
        const torrent = this.currentFile._torrent
        this.buildVideo(torrent, { media: nowPlaying, file: this.videoFiles[this.videoFiles.indexOf(this.currentFile) + 1] })
      } else {
        this.emit('next', { file: this.currentFile, filemedia: this.nowPlaying })
      }
    }, 200)
  }

  playLast () {
    clearTimeout(this.nextTimeout)
    this.nextTimeout = setTimeout(() => {
      if (this.videoFiles?.indexOf(this.currentFile)) {
        const nowPlaying = this.nowPlaying
        nowPlaying.episodeNumber -= 1
        const torrent = this.currentFile._torrent
        this.buildVideo(torrent, { media: nowPlaying, file: this.videoFiles[this.videoFiles.indexOf(this.currentFile) - 1] })
      } else {
        this.emit('prev', { file: this.currentFile, filemedia: this.nowPlaying })
      }
    }, 200)
  }

  toggleCast () {
    if (this.video.readyState) {
      if (this.presentationConnection) {
        this.presentationConnection?.terminate()
      } else {
        this.presentationRequest.start()
      }
    }
  }

  initCast (event) {
    let peer = new Peer({ polite: true })

    this.presentationConnection = event.connection
    this.presentationConnection.addEventListener('terminate', () => {
      this.presentationConnection = null
      this.changeControlsIcon('toggleCast', 'cast')
      this.player.classList.remove('pip')
      peer = null
    })

    peer.signalingPort.onmessage = ({ data }) => {
      this.presentationConnection.send(data)
    }

    this.presentationConnection.addEventListener('message', ({ data }) => {
      peer.signalingPort.postMessage(data)
    })

    peer.dc.onopen = async () => {
      await this.fps
      if (peer && this.presentationConnection) {
        this.changeControlsIcon('toggleCast', 'cast_connected')
        this.player.classList.add('pip')
        const tracks = []
        const videostream = this.video.captureStream()
        if (this.burnIn) {
          const { stream, destroy } = await this.getBurnIn(!this.subtitleData.renderer)
          tracks.push(stream.getVideoTracks()[0], videostream.getAudioTracks()[0])
          this.presentationConnection.addEventListener('terminate', destroy)
        } else {
          tracks.push(videostream.getVideoTracks()[0], videostream.getAudioTracks()[0])
        }
        for (const track of tracks) {
          peer.pc.addTrack(track, videostream)
        }
        this.video.play() // video pauses for some reason
      }
    }
  }

  async togglePopout () {
    if (this.video.readyState) {
      if (this.burnIn) {
        await this.fps
        if (!this.subtitleData.renderer) {
          this.video !== document.pictureInPictureElement ? this.video.requestPictureInPicture() : document.exitPictureInPicture()
        } else {
          if (document.pictureInPictureElement && !document.pictureInPictureElement.id) { // only exit if pip is the custom one, else overwrite existing pip with custom
            document.exitPictureInPicture()
          } else {
            const canvasVideo = document.createElement('video')
            const { stream, destroy } = await this.getBurnIn()
            canvasVideo.srcObject = stream
            canvasVideo.onloadedmetadata = () => {
              canvasVideo.play()
              canvasVideo.requestPictureInPicture().then(
                this.player.classList.add('pip')
              ).catch(e => {
                console.warn('Failed To Burn In Subtitles ' + e)
                destroy()
                canvasVideo.remove()
                this.player.classList.remove('pip')
              })
            }
            canvasVideo.onleavepictureinpicture = () => {
              destroy()
              canvasVideo.remove()
              this.player.classList.remove('pip')
            }
          }
        }
      } else {
        this.video !== document.pictureInPictureElement ? this.video.requestPictureInPicture() : document.exitPictureInPicture()
      }
    }
  }

  async getBurnIn (noSubs) {
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d', { alpha: false })
    const fps = await this.fps
    let loop = null
    let destroy = null
    canvas.width = this.video.videoWidth
    canvas.height = this.video.videoHeight
    if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
      const renderFrame = async () => {
        context.drawImage(this.video, 0, 0)
        if (!noSubs) context.drawImage(this.subtitleData.renderer?.canvas, 0, 0, canvas.width, canvas.height)
        loop = this.video.requestVideoFrameCallback(renderFrame)
      }
      loop = this.video.requestVideoFrameCallback(renderFrame)
      destroy = () => {
        this.video.cancelVideoFrameCallback(loop)
        canvas.remove()
      }
    } else {
      // for the firefox idiots
      const renderFrame = () => {
        context.drawImage(this.video, 0, 0)
        if (!noSubs) context.drawImage(this.subtitleData.renderer?.canvas, 0, 0, canvas.width, canvas.height)
        loop = requestTimeout(renderFrame, 500 / fps)
      }
      loop = requestAnimationFrame(renderFrame)
      destroy = () => {
        cancelTimeout(loop)
        canvas.remove()
      }
    }
    return { stream: canvas.captureStream(), destroy }
  }

  toTS (sec, full) {
    if (isNaN(sec) || sec < 0) {
      return full ? '0:00:00.00' : '00:00'
    }
    const hours = Math.floor(sec / 3600)
    let minutes = Math.floor(sec / 60) - (hours * 60)
    let seconds = full ? (sec % 60).toFixed(2) : Math.floor(sec % 60)
    if (minutes < 10) minutes = '0' + minutes
    if (seconds < 10) seconds = '0' + seconds
    return (hours > 0 || full) ? hours + ':' + minutes + ':' + seconds : minutes + ':' + seconds
  }

  prettyBytes (num) {
    if (isNaN(num)) return '0 B'
    if (num < 1) return num + ' B'
    const exponent = Math.min(Math.floor(Math.log(num) / Math.log(1000)), units.length - 1)
    return Number((num / Math.pow(1000, exponent)).toFixed(2)) + units[exponent]
  }

  getBytes (str) {
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'Bytes', 'KB', 'MB', 'GB', 'TB']
    const split = str.split(' ')
    return split[0] * 1024 ** (units.indexOf(split[1] || 'B') % 5) // this is so lazy
  }

  seek (time) {
    if (time === 85 && this.video.currentTime < 10) {
      this.video.currentTime = 90
    } else if (time === 85 && (this.video.duration - this.video.currentTime) < 90) {
      this.video.currentTime = this.video.duration
    } else {
      this.video.currentTime += time
    }
    this.setProgress(this.video.currentTime / this.video.duration * 100)
  }

  forward () {
    this.seek(this.seekTime)
  }

  rewind () {
    this.seek(-this.seekTime)
  }

  immersePlayer () {
    this.player.classList.add('immersed')
    this.immerseTimeout = undefined
  }

  resetImmerse () {
    if (this.immerseTimeout) {
      clearTimeout(this.immerseTimeout)
    } else {
      this.player.classList.remove('immersed')
    }
    this.immerseTimeout = setTimeout(() => this.immersePlayer(), this.immerseTime * 1000)
  }

  hideBuffering () {
    if (this.bufferTimeout) {
      clearTimeout(this.bufferTimeout)
      this.bufferTimeout = undefined
      this.player.classList.remove('buffering')
    }
  }

  showBuffering () {
    this.bufferTimeout = setTimeout(() => {
      this.player.classList.add('buffering')
      this.resetImmerse()
    }, 150)
  }

  checkCompletion () {
    if (!this.completed && this.video.duration - 180 < this.video.currentTime) {
      this.completed = true
      this.emit('watched', { file: this.currentFile, filemedia: this.nowPlaying })
    }
  }

  updatePositionState () {
    if (this.video.duration) {
      navigator.mediaSession.setPositionState({
        duration: this.video.duration || 0,
        playbackRate: this.video.playbackRate || 0,
        position: this.video.currentTime || 0
      })
    }
  }

  initThumbnail () {
    const height = this.thumbnailData.canvas.width / (this.video.videoWidth / this.video.videoHeight)
    this.thumbnailData.interval = this.video.duration / 300 < 5 ? 5 : this.video.duration / 300
    this.thumbnailData.canvas.height = height
    this.controls.thumbnail.style.setProperty('height', height + 'px')
  }

  createThumbnail (video) {
    if (video?.readyState >= 2) {
      const index = Math.floor(video.currentTime / this.thumbnailData.interval)
      if (!this.thumbnailData.thumbnails[index]) {
        this.thumbnailData.context.fillRect(0, 0, 150, this.thumbnailData.canvas.height)
        this.thumbnailData.context.drawImage(video, 0, 0, 150, this.thumbnailData.canvas.height)
        this.thumbnailData.thumbnails[index] = this.thumbnailData.canvas.toDataURL('image/jpeg')
      }
    }
  }

  finishThumbnails (src) {
    const t0 = performance.now()
    const video = document.createElement('video')
    let index = 0
    video.preload = 'none'
    video.volume = 0
    video.playbackRate = 0
    video.addEventListener('loadeddata', () => loadTime())
    video.addEventListener('canplay', () => {
      this.createThumbnail(this.thumbnailData.video)
      loadTime()
    })
    this.thumbnailData.video = video
    const loadTime = () => {
      while (this.thumbnailData.thumbnails[index] && index <= Math.floor(this.thumbnailData.video.duration / this.thumbnailData.interval)) { // only create thumbnails that are missing
        index++
      }
      if (this.thumbnailData.video?.currentTime !== this.thumbnailData.video?.duration) {
        this.thumbnailData.video.currentTime = index * this.thumbnailData.interval
      } else {
        this.thumbnailData.video?.removeAttribute('src')
        this.thumbnailData.video?.load()
        this.thumbnailData.video?.remove()
        delete this.thumbnailData.video
        console.log('Thumbnail creating finished', index, this.toTS((performance.now() - t0) / 1000))
      }
      index++
    }
    this.thumbnailData.video.src = src
    this.thumbnailData.video.play()
    console.log('Thumbnail creating started')
  }

  dragBarEnd (progressPercent) {
    this.video.currentTime = this.video.duration * progressPercent / 100 || 0
    this.playVideo()
  }

  dragBarStart (progressPercent) {
    this.video.pause()
    this.setProgress(progressPercent)
  }

  setProgress (progressPercent) {
    progressPercent = progressPercent || 0
    const currentTime = this.video.duration * progressPercent / 100 || 0
    if (this.controls.progressWrapper) this.controls.progressWrapper.style.setProperty('--progress', progressPercent + '%')
    if (this.controls.thumbnail) this.controls.thumbnail.src = this.thumbnailData.thumbnails[Math.floor(currentTime / this.thumbnailData.interval)] || ' '
    if (this.controls.setProgress) {
      this.controls.setProgress.dataset.elapsed = this.toTS(currentTime)
      this.controls.setProgress.value = progressPercent
    }
    if (this.controls.progressWrapper) {
      this.controls.progressWrapper.dataset.elapsed = this.toTS(currentTime)
      this.controls.progressWrapper.dataset.remaining = this.toTS(this.video.duration - currentTime)
    }
  }

  updateDisplay () {
    if (this.currentFile && this.currentFile._torrent) {
      if (this.player) this.player.style.setProperty('--download', this.currentFile.progress * 100 + '%')
      if (this.controls.peers) this.controls.peers.dataset.value = this.currentFile._torrent.numPeers
      if (this.controls.downSpeed) this.controls.downSpeed.dataset.value = this.prettyBytes(this.currentFile._torrent.downloadSpeed) + '/s'
      if (this.controls.upSpeed) this.controls.upSpeed.dataset.value = this.prettyBytes(this.currentFile._torrent.uploadSpeed) + '/s'
    }
    setTimeout(() => requestAnimationFrame(() => this.updateDisplay()), 200)
  }

  createRadioElement (track, type) {
    // type: captions audio
    if ((type === 'captions' && this.controls.selectCaptions && this.controls.captionsButton) || (type === 'audio' && this.controls.selectAudio)) {
      const frag = document.createDocumentFragment()
      const input = document.createElement('input')
      const label = document.createElement('label')
      input.name = `${type}-radio-set`
      input.type = 'radio'
      input.id = type === 'captions' ? `${type}-${track ? track.number : 'off'}-radio` : `${type}-${track.id}-radio`
      input.value = type === 'captions' ? track ? track.number : -1 : track.id
      input.checked = type === 'captions' ? track?.number === this.subtitleData.current : track.enabled
      label.htmlFor = type === 'captions' ? `${type}-${track ? track.number : 'off'}-radio` : `${type}-${track.id}-radio`
      label.textContent = track
        ? type === 'captions'
            ? (track.language || (!Object.values(this.subtitleData.headers).some(header => header.language === 'eng' || header.language === 'en') ? 'eng' : track.type)) + (track.name ? ' - ' + track.name : '')
            : (track.language || (!Object.values(this.video.audioTracks).some(track => track.language === 'eng' || track.language === 'en') ? 'eng' : track.label)) + (track.label ? ' - ' + track.label : '')
        : 'OFF' // TODO: clean this up, TLDR assume english track if track lang is undefined || 'und' and there isnt an existing eng track already
      frag.append(input)
      frag.append(label)
      if (type === 'captions') {
        this.controls.selectCaptions.append(frag)
        this.controls.captionsButton.removeAttribute('disabled')
      } else {
        this.controls.selectAudio.append(frag)
      }
    }
  }

  selectAudio (id) {
    if (id !== undefined) {
      for (const track of this.video.audioTracks) {
        track.enabled = track.id === id
      }
      this.seek(-0.5) // stupid fix because video freezes up when chaging tracks
    }
  }

  selectCaptions (trackNumber) {
    if (trackNumber !== undefined) {
      trackNumber = Number(trackNumber)
      this.subtitleData.current = trackNumber
      if (!this.subtitleData.timeout) {
        this.subtitleData.timeout = setTimeout(() => {
          this.subtitleData.timeout = undefined
          if (this.subtitleData.renderer) {
            this.subtitleData.renderer.setTrack(trackNumber !== -1 ? this.subtitleData.headers[trackNumber].header.slice(0, -1) + Array.from(this.subtitleData.tracks[trackNumber]).join('\n') : this.subtitleData.defaultHeader)
          }
        }, 1000)
      }
    }
  }

  constructSub (subtitle, isNotAss) {
    if (isNotAss === true) { // converts VTT or other to SSA
      const matches = subtitle.text.match(/<[^>]+>/g) // create array of all tags
      if (matches) {
        matches.forEach(match => {
          if (/<\//.test(match)) { // check if its a closing tag
            subtitle.text = subtitle.text.replace(match, match.replace('</', '{\\').replace('>', '0}'))
          } else {
            subtitle.text = subtitle.text.replace(match, match.replace('<', '{\\').replace('>', '1}'))
          }
        })
      }
      // replace all html special tags with normal ones
      subtitle.text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, '\\h')
    }
    return 'Dialogue: ' +
    (subtitle.layer || 0) + ',' +
    this.toTS(subtitle.time / 1000, true) + ',' +
    this.toTS((subtitle.time + subtitle.duration) / 1000, true) + ',' +
    (subtitle.style || 'Default') + ',' +
    (subtitle.name || '') + ',' +
    (subtitle.marginL || '0') + ',' +
    (subtitle.marginR || '0') + ',' +
    (subtitle.marginV || '0') + ',' +
    (subtitle.effect || '') + ',' +
    subtitle.text || ''
  }

  parseSubtitles (file, skipFiles) { // parse subtitles fully after a download is finished
    return new Promise((resolve) => {
      if (file.name.endsWith('.mkv')) {
        let parser = new SubtitleParser()
        this.handleSubtitleParser(parser, skipFiles)
        const finish = () => {
          console.log('Sub parsing finished', this.toTS((performance.now() - t0) / 1000))
          this.subtitleData.parsed = true
          this.subtitleData.stream?.destroy()
          this.subtitleData.parser?.destroy()
          fileStream?.destroy()
          this.subtitleData.stream = undefined
          this.subtitleData.parser = undefined
          this.selectCaptions(this.subtitleData.current)
          parser = undefined
          if (!this.video.paused) {
            this.video.pause()
            this.playVideo()
          }
          resolve()
        }
        parser.once('tracks', tracks => {
          if (!tracks.length) finish()
        })
        parser.once('finish', finish)
        const t0 = performance.now()
        console.log('Sub parsing started')
        const fileStream = file.createReadStream()
        this.subtitleData.parser = fileStream.pipe(parser)
      } else {
        resolve()
      }
    })
  }

  initParser (file) {
    return new Promise(resolve => {
      const stream = this.subtitleData.stream = new SubtitleParser()
      this.handleSubtitleParser(this.subtitleData.stream)
      stream.once('tracks', tracks => {
        if (!tracks.length) {
          this.subtitleData.parsed = true
          resolve()
          this.subtitleData.stream.destroy()
          fileStreamStream.destroy()
        }
      })
      stream.on('subtitle', () => {
        resolve()
        fileStreamStream.destroy()
      })
      const fileStreamStream = file.createReadStream({ end: file.length / 2 })
      fileStreamStream.pipe(stream)
    })
  }

  handleSubtitleParser (parser, skipFile) {
    parser.once('tracks', tracks => {
      if (!tracks.length) {
        this.subtitleData.parsed = true
      } else {
        tracks.forEach(track => {
          if (!this.subtitleData.tracks[track.number]) {
            // overwrite webvtt or other header with custom one
            if (track.type !== 'ass') track.header = this.subtitleData.defaultHeader
            if (!this.subtitleData.current) {
              this.subtitleData.current = track.number
              this.createRadioElement(undefined, 'captions')
            }
            this.subtitleData.tracks[track.number] = new Set()
            this.subtitleData.headers[track.number] = track
            this.createRadioElement(track, 'captions')
          }
        })
      }
    })
    parser.on('subtitle', (subtitle, trackNumber) => {
      if (!this.subtitleData.parsed) {
        if (!this.subtitleData.renderer) this.initSubtitleRenderer()
        this.subtitleData.tracks[trackNumber].add(this.constructSub(subtitle, this.subtitleData.headers[trackNumber].type !== 'ass'))
        if (this.subtitleData.current === trackNumber) this.selectCaptions(trackNumber)
      }
    })
    if (!skipFile) {
      parser.on('file', file => {
        if (file.mimetype === 'application/x-truetype-font' || file.mimetype === 'application/font-woff' || file.mimetype === 'application/vnd.ms-opentype') {
          this.subtitleData.fonts.push(URL.createObjectURL(new Blob([file.data], { type: file.mimetype })))
        }
      })
    }
  }

  async initSubtitleRenderer () {
    if (!this.subtitleData.renderer) {
      const options = {
        video: this.video,
        targetFps: await this.fps,
        subContent: this.subtitleData.headers[this.subtitleData.current].header.slice(0, -1),
        renderMode: 'offscreen',
        fonts: this.subtitleData.fonts,
        fallbackFont: 'https://fonts.gstatic.com/s/roboto/v20/KFOlCnqEu92Fr1MmEU9fBBc4.woff2',
        workerUrl: 'lib/subtitles-octopus-worker.js',
        onReady: () => { // weird hack for laggy subtitles, this is some issue in SO
          if (!this.video.paused) {
            this.video.pause()
            this.playVideo()
          }
        }
      }
      if (!this.subtitleData.renderer) {
        this.subtitleData.renderer = new SubtitlesOctopus(options)
        this.selectCaptions(this.subtitleData.current)
      }
    }
  }

  convertSubFile (file, isAss, callback) {
    const regex = /(?:\d+\n)?(\S{9,12})\s?-->\s?(\S{9,12})(.*)\n([\s\S]*)$/i
    file.getBuffer((_err, buffer) => {
      const subtitles = isAss ? buffer.toString() : []
      if (isAss) {
        callback(subtitles)
      } else {
        const text = buffer.toString().replace(/\r/g, '')
        for (const split of text.split('\n\n')) {
          const match = split.match(regex)
          if (match) {
            match[1] = match[1].match(/.*[.,]\d{2}/)[0]
            match[2] = match[2].match(/.*[.,]\d{2}/)[0]
            if (match[1].length === 9) {
              match[1] = '0:' + match[1]
            } else {
              if (match[1][0] === '0') {
                match[1] = match[1].substring(1)
              }
            }
            match[1].replace(',', '.')
            if (match[2].length === 9) {
              match[2] = '0:' + match[2]
            } else {
              if (match[2][0] === '0') {
                match[2] = match[2].substring(1)
              }
            }
            match[2].replace(',', '.')
            const matches = match[4].match(/<[^>]+>/g) // create array of all tags
            if (matches) {
              matches.forEach(matched => {
                if (/<\//.test(matched)) { // check if its a closing tag
                  match[4] = match[4].replace(matched, matched.replace('</', '{\\').replace('>', '0}'))
                } else {
                  match[4] = match[4].replace(matched, matched.replace('<', '{\\').replace('>', '1}'))
                }
              })
            }
            subtitles.push('Dialogue: 0,' + match[1].replace(',', '.') + ',' + match[2].replace(',', '.') + ',Default,,0,0,0,,' + match[4])
          }
        }
        callback(subtitles)
      }
    })
  }

  findSubtitleFiles (targetFile) {
    const path = targetFile.path.split(targetFile.name)[0]
    // array of subtitle files that match video name, or all subtitle files when only 1 vid file
    const subtitleFiles = targetFile._torrent.files.filter(file => {
      return this.subtitleExtensions.some(ext => file.name.endsWith(ext)) && (this.videoFiles.length === 1 ? true : file.path.split(path).length === 2)
    })
    if (subtitleFiles.length) {
      this.createRadioElement(undefined, 'captions')
      this.subtitleData.parsed = true
      this.subtitleData.current = 0
      for (const [index, file] of subtitleFiles.entries()) {
        const isAss = file.name.endsWith('.ass') || file.name.endsWith('.ssa')
        const extension = /\.(\w+)$/
        const name = file.name.replace(targetFile.name, '') === file.name
          ? file.name.replace(targetFile.name.replace(extension, ''), '').slice(0, -4).replace(/[,._-]/g, ' ').trim()
          : file.name.replace(targetFile.name, '').slice(0, -4).replace(/[,._-]/g, ' ').trim()
        const header = {
          header: this.subtitleData.defaultHeader,
          language: name,
          number: index,
          type: file.name.match(extension)[1]
        }
        this.subtitleData.headers.push(header)
        this.subtitleData.tracks[index] = []
        this.createRadioElement(header, 'captions')
        this.convertSubFile(file, isAss, subtitles => {
          if (isAss) {
            this.subtitleData.headers[index].header = subtitles
          } else {
            this.subtitleData.tracks[index] = subtitles
          }
          if (this.subtitleData.current === index) this.selectCaptions(this.subtitleData.current)
        })
        this.initSubtitleRenderer()
      }
    }
  }

  postDownload () {
    this.emit('download-done', { file: this.currentFile })
    this.parseSubtitles(this.currentFile, true).then(() => {
      if (this.generateThumbnails) {
        this.finishThumbnails(this.video.src)
      }
    })
  }

  playTorrent (torrentID, opts = {}) { // TODO: clean this up
    const handleTorrent = (torrent, opts) => {
      torrent.on('noPeers', () => {
        this.emit('no-peers', torrent)
      })
      if (this.streamedDownload) {
        torrent.files.forEach(file => file.deselect())
        torrent.deselect(0, torrent.pieces.length - 1, false)
      }
      this.videoFiles = torrent.files.filter(file => this.videoExtensions.some(ext => file.name.endsWith(ext)))
      this.emit('video-files', { files: this.videoFiles, torrent: torrent })
      if (this.videoFiles.length > 1) {
        torrent.files.forEach(file => file.deselect())
      }
      if (this.videoFiles) {
        this.buildVideo(torrent, opts)
      } else {
        this.emit('no-file', torrent)
        this.cleanupTorrents()
      }
    }
    document.location.hash = '#player'
    this.cleanupVideo()
    this.cleanupTorrents()
    if (torrentID instanceof Object) {
      handleTorrent(torrentID, opts)
    } else if (this.get(torrentID)) {
      handleTorrent(this.get(torrentID), opts)
    } else {
      this.add(torrentID, {
        destroyStoreOnDestroy: this.destroyStore,
        storeOpts: this.storeOpts,
        storeCacheSlots: 0,
        store: HybridChunkStore,
        announce: this.tracker.announce || [
          'wss://tracker.openwebtorrent.com',
          'wss://spacetradersapi-chatbox.herokuapp.com:443/announce',
          'wss://peertube.cpy.re:443/tracker/socket'
        ]
      }, torrent => {
        handleTorrent(torrent, opts)
      })
    }
  }

  // cleanup torrent and store
  cleanupTorrents () {
  // creates an array of all non-offline store torrents and removes them
    this.torrents.filter(torrent => !this.offlineTorrents[torrent.infoHash]).forEach(torrent => torrent.destroy())
  }

  // add torrent for offline download
  offlineDownload (torrentID) {
    const torrent = this.add(torrentID, {
      storeOpts: this.storeOpts,
      store: HybridChunkStore,
      storeCacheSlots: 0,
      announce: this.tracker.announce || [
        'wss://tracker.openwebtorrent.com',
        'wss://spacetradersapi-chatbox.herokuapp.com:443/announce',
        'wss://peertube.cpy.re:443/tracker/socket'
      ]
    })
    torrent.on('metadata', () => {
      if (!this.offlineTorrents[torrent.infoHash]) {
        this.offlineTorrents[torrent.infoHash] = Array.from(torrent.torrentFile)
        localStorage.setItem('offlineTorrents', JSON.stringify(this.offlineTorrents))
      }
      this.emit('offline-torrent', torrent)
    })
  }
}
