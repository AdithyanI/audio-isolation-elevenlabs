import { NextRequest, NextResponse } from 'next/server'
import { ElevenLabsClient } from 'elevenlabs'
import { uploadToS3 } from '@/lib/s3'
import { Readable } from 'stream'
import { Buffer } from 'buffer'

// Add these constants at the top of the file
const MODAL_START_MERGE_URL = process.env.MODAL_START_MERGE_URL || ''
const MODAL_CHECK_STATUS_URL = process.env.MODAL_CHECK_STATUS_URL || ''
const MODAL_API_KEY = process.env.MODAL_API_KEY || ''

// Helper function to poll job status
async function pollJobStatus(jobId: string, maxAttempts = 60, intervalMs = 5000) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await fetch(MODAL_CHECK_STATUS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${MODAL_API_KEY}`
      },
      body: JSON.stringify({ job_id: jobId })
    })

    if (!response.ok) {
      throw new Error('Failed to check job status')
    }

    const statusData = await response.json()

    switch (statusData.status) {
      case 'completed':
        return statusData.output_url
      case 'error':
        throw new Error(statusData.error || 'Job processing failed')
      case 'processing':
        await new Promise(resolve => setTimeout(resolve, intervalMs))
        break
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

export async function POST(req: NextRequest) {
  try {
    const apiKey = process.env.ELEVEN_LABS_API_KEY
    if (!apiKey) {
      throw new Error('ELEVEN_LABS_API_KEY is not set in the environment variables')
    }

    const formData = await req.formData()
    const audio = formData.get('audio') as File

    if (!audio) {
      return NextResponse.json({ error: 'No audio file provided' }, { status: 400 })
    }

    // First, upload the original video to S3
    const videoBuffer = Buffer.from(await audio.arrayBuffer())
    const originalVideoName = `${Date.now()}-original-${audio.name}`
    const videoUrl = await uploadToS3(videoBuffer, `original-videos/${originalVideoName}`)

    const client = new ElevenLabsClient({ apiKey })

    // Convert File to ArrayBuffer for ElevenLabs
    const arrayBuffer = await audio.arrayBuffer()
    const uint8Array = new Uint8Array(arrayBuffer)

    // Process audio with ElevenLabs
    const processedAudio = await client.audioIsolation.audioIsolation({
      audio: new Blob([uint8Array], { type: audio.type })
    })

    // Convert the stream to buffer
    const audioBuffer = await streamToBuffer(processedAudio as unknown as Readable)

    // Generate a unique filename for processed audio
    const audioFileName = `${Date.now()}-processed-${audio.name.replace(/\.[^/.]+$/, '')}.wav`
    const audioUrl = await uploadToS3(audioBuffer, `processed-audio/${audioFileName}`)

    // Call Modal start_merge endpoint
    const mergeResponse = await fetch(MODAL_START_MERGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${MODAL_API_KEY}`
      },
      body: JSON.stringify({ 
        video_url: videoUrl, 
        audio_url: audioUrl 
      })
    })

    if (!mergeResponse.ok) {
      throw new Error('Failed to start video merge job')
    }

    const mergeData = await mergeResponse.json()
    const jobId = mergeData.job_id

    // Poll for job status and get final video URL
    const finalVideoUrl = await pollJobStatus(jobId)

    return NextResponse.json({ 
      originalVideo: videoUrl,
      processedAudio: audioUrl,
      finalVideo: finalVideoUrl
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

