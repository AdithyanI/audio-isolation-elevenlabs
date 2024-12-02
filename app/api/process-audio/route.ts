import { NextRequest, NextResponse } from 'next/server'
import { ElevenLabsClient } from 'elevenlabs'
import { uploadToS3 } from '@/lib/s3'
import { Readable } from 'stream'
import { Buffer } from 'buffer'

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

    // TODO: Call Modal function here to merge video and audio
    // const modalResponse = await fetch('YOUR_MODAL_FUNCTION_URL', {
    //   method: 'POST',
    //   body: JSON.stringify({ videoUrl, audioUrl }),
    // })

    // For now, return both URLs
    return NextResponse.json({ 
      originalVideo: videoUrl,
      processedAudio: audioUrl,
      // finalVideo: will come from Modal later
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

