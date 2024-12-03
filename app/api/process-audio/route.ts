import { NextRequest, NextResponse } from 'next/server'
import { ElevenLabsClient } from 'elevenlabs'
import { uploadToS3 } from '@/lib/s3'
import { Readable } from 'stream'
import { Buffer } from 'buffer'

// Add these constants at the top of the file
const MODAL_START_MERGE_URL = process.env.MODAL_START_MERGE_URL
const MODAL_CHECK_STATUS_URL = process.env.MODAL_CHECK_STATUS_URL
const MODAL_API_KEY = process.env.MODAL_API_KEY
const ELEVEN_LABS_API_KEY = process.env.ELEVEN_LABS_API_KEY
const MAX_RETRIES = 3
const RETRY_DELAY = 5000 // 5 seconds

// Validate environment variables
if (!MODAL_START_MERGE_URL || !MODAL_CHECK_STATUS_URL || !MODAL_API_KEY) {
  console.error('Missing required Modal API configuration')
}

if (!ELEVEN_LABS_API_KEY) {
  console.error('Missing required ElevenLabs API configuration')
}

// Helper function to validate file type
function isValidVideoFile(file: File): boolean {
  const validTypes = ['video/mp4', 'video/quicktime', 'video/x-msvideo']
  return validTypes.includes(file.type)
}

interface ModalResponse {
  job_id: string
  status: 'processing' | 'completed' | 'error'
  url?: string
  error?: string
}

// Helper function to poll job status
async function pollJobStatus(jobId: string, maxAttempts = 60, intervalMs = 5000): Promise<string> {
  if (!MODAL_CHECK_STATUS_URL || !MODAL_API_KEY) {
    throw new Error('Modal API configuration is missing')
  }

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      // Construct URL with query parameter
      const statusUrl = `${MODAL_CHECK_STATUS_URL}?job_id=${jobId}`
      
      const response = await fetch(statusUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${MODAL_API_KEY}`
        }
      })

      if (!response.ok) {
        const errorText = await response.text()
        console.error('Status check failed:', errorText)
        throw new Error(`Failed to check job status: ${response.status} ${response.statusText}`)
      }

      const statusData = await response.json() as ModalResponse
      console.log('Status check response:', statusData)

      switch (statusData.status) {
        case 'completed':
          if (!statusData.url) {
            console.error('Missing URL in completed response:', statusData)
            throw new Error('Completed status received but missing URL in response')
          }
          return statusData.url
        case 'error':
          throw new Error(statusData.error || 'Job processing failed')
        case 'processing':
          console.log(`Job still processing, attempt ${attempt + 1}/${maxAttempts}`)
          await new Promise(resolve => setTimeout(resolve, intervalMs))
          break
        default:
          console.warn('Unexpected status:', statusData.status)
          throw new Error(`Unexpected status: ${statusData.status}`)
      }
    } catch (error) {
      console.error(`Polling attempt ${attempt + 1} failed:`, error)
      // Don't continue polling if we get a definitive error
      if (error instanceof Error && 
          (error.message.includes('missing URL') || 
           error.message.includes('Unexpected status') ||
           error.message.includes('Job processing failed'))) {
        throw error
      }
      if (attempt === maxAttempts - 1) throw error
      await new Promise(resolve => setTimeout(resolve, intervalMs))
    }
  }

  throw new Error('Job processing timed out')
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk))
  }
  
  return Buffer.concat(chunks)
}

// Add this helper function for retrying operations
async function retry<T>(
  operation: () => Promise<T>,
  retries: number = MAX_RETRIES,
  delay: number = RETRY_DELAY,
  context: string = ''
): Promise<T> {
  let lastError: Error | undefined

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await operation()
    } catch (error) {
      lastError = error as Error
      if (attempt === retries) break

      console.log(`Attempt ${attempt} failed for ${context}:`, error)
      console.log(`Retrying in ${delay/1000} seconds...`)
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }

  throw lastError
}

export async function POST(req: NextRequest) {
  try {
    if (!ELEVEN_LABS_API_KEY) {
      throw new Error('ELEVEN_LABS_API_KEY is not set in the environment variables')
    }

    if (!MODAL_START_MERGE_URL || !MODAL_API_KEY) {
      throw new Error('Modal API configuration is missing')
    }

    const formData = await req.formData()
    const video = formData.get('audio') as File
    const videoUrl = formData.get('videoUrl') as string

    if (!video && !videoUrl) {
      return NextResponse.json({ error: 'No video file or URL provided' }, { status: 400 })
    }

    let finalVideoUrl: string
    let audioInput: { audio: Blob | File }

    if (videoUrl) {
      // Validate video URL
      try {
        const urlObj = new URL(videoUrl)
        const extension = urlObj.pathname.split('.').pop()?.toLowerCase()
        if (!extension || !['mp4', 'mov', 'avi'].includes(extension)) {
          return NextResponse.json({ 
            error: 'Invalid video URL. URL must point to an MP4, MOV, or AVI file' 
          }, { status: 400 })
        }
        finalVideoUrl = videoUrl
      } catch (urlError) {
        console.error('URL validation failed:', urlError)
        return NextResponse.json({ error: 'Invalid URL format' }, { status: 400 })
      }

      // Fetch video from URL to pass to ElevenLabs
      try {
        const videoResponse = await fetch(videoUrl)
        if (!videoResponse.ok) {
          throw new Error(`Failed to fetch video: ${videoResponse.statusText}`)
        }
        const videoBlob = await videoResponse.blob()
        audioInput = { audio: videoBlob }
      } catch (fetchError) {
        console.error('Failed to fetch video:', fetchError)
        return NextResponse.json({ 
          error: 'Failed to access video URL. Please ensure the URL is publicly accessible.' 
        }, { status: 400 })
      }
    } else {
      // Handle uploaded file
      if (!isValidVideoFile(video)) {
        return NextResponse.json({ 
          error: 'Invalid file type. Please upload a video file (MP4, MOV, or AVI)' 
        }, { status: 400 })
      }

      // Create a Blob from the video file
      const videoBlob = new Blob([await video.arrayBuffer()], { type: video.type })
      audioInput = { audio: videoBlob }

      // Upload original video to S3
      const videoBuffer = Buffer.from(await video.arrayBuffer())
      const originalVideoName = `${Date.now()}-original-${video.name}`
      finalVideoUrl = await uploadToS3(videoBuffer, `original-videos/${originalVideoName}`)
    }

    const client = new ElevenLabsClient({ apiKey: ELEVEN_LABS_API_KEY })

    // Process audio with ElevenLabs with retry logic
    const processedAudio = await retry(
      async () => {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 300000) // 5 minutes timeout

        try {
          const result = await client.audioIsolation.audioIsolation(audioInput, {
            signal: controller.signal
          })
          if (!result) {
            throw new Error('No audio received from ElevenLabs')
          }
          return result
        } finally {
          clearTimeout(timeout)
        }
      },
      MAX_RETRIES,
      RETRY_DELAY,
      'ElevenLabs audio processing'
    ).catch(error => {
      if (error.name === 'AbortError') {
        throw new Error('ElevenLabs processing timed out after 5 minutes')
      }
      console.error('All retry attempts failed for ElevenLabs:', error)
      throw new Error(`ElevenLabs audio processing failed after ${MAX_RETRIES} attempts: ${error.message}`)
    })

    // Convert the stream to buffer
    const audioBuffer = await streamToBuffer(processedAudio as unknown as Readable)

    // Generate a unique filename for processed audio
    const fileName = videoUrl ? 
      new URL(videoUrl).pathname.split('/').pop() || 'video' : 
      (video as File).name
    const audioFileName = `${Date.now()}-processed-${fileName.replace(/\.[^/.]+$/, '')}.wav`
    const audioUrl = await uploadToS3(audioBuffer, `processed-audio/${audioFileName}`)

    // Call Modal start_merge endpoint
    const mergeResponse = await fetch(MODAL_START_MERGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${MODAL_API_KEY}`
      },
      body: JSON.stringify({ 
        video_url: finalVideoUrl, 
        audio_url: audioUrl 
      })
    })

    if (!mergeResponse.ok) {
      const errorText = await mergeResponse.text()
      throw new Error(`Failed to start video merge job: ${errorText}`)
    }

    const mergeData = await mergeResponse.json()
    if (!mergeData.job_id) {
      throw new Error('No job ID received from Modal API')
    }

    // Poll for job status and get final video URL
    const finalProcessedVideoUrl = await pollJobStatus(mergeData.job_id)

    return NextResponse.json({ 
      processedAudio: audioUrl,
      finalVideo: finalProcessedVideoUrl
    })

  } catch (error) {
    console.error('Error processing audio:', error)
    let errorMessage = 'An unexpected error occurred while processing the audio'
    if (error instanceof Error) {
      errorMessage = error.message
    }

    return NextResponse.json({ error: errorMessage }, { status: 500 })
  }
}

