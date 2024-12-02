'use client'

import { useState } from 'react'
import { useDropzone } from 'react-dropzone'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Upload, LinkIcon, Loader2 } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

export default function VideoProcessor() {
  const [file, setFile] = useState<File | null>(null)
  const [url, setUrl] = useState('')
  const [processing, setProcessing] = useState(false)
  const [processedUrl, setProcessedUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const onDrop = (acceptedFiles: File[]) => {
    setFile(acceptedFiles[0])
    setUrl('')
    setError(null)
  }

  const { getRootProps, getInputProps, isDragActive } = useDropzone({ 
    onDrop,
    accept: { 'video/*': ['.mp4', '.mov', '.avi'] },
    maxSize: 100 * 1024 * 1024 // 100MB
  })

  const handleProcess = async () => {
    if (!file && !url) {
      setError('Please provide a video file or URL')
      return
    }

    setProcessing(true)
    setError(null)

    const formData = new FormData()
    
    try {
      if (url) {
        const response = await fetch(url)
        if (!response.ok) throw new Error(`Failed to fetch video from URL: ${response.statusText}`)
        const blob = await response.blob()
        formData.append('audio', blob, 'video.mp4')
      } else if (file) {
        formData.append('audio', file)
      }

      const response = await fetch('/api/process-audio', {
        method: 'POST',
        body: formData,
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || 'Audio processing failed')
      }

      const data = await response.json()
      setProcessedUrl(data.url)
    } catch (error) {
      console.error('Error processing video:', error)
      setError(error instanceof Error ? error.message : 'An unexpected error occurred. Please try again.')
    } finally {
      setProcessing(false)
    }
  }

  return (
    <Card className="w-full">
      <CardHeader className="text-center">
        <CardTitle>Audio Noise Cleaner</CardTitle>
        <CardDescription>
          Upload a video file or provide a URL to clean up the audio
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Tabs defaultValue="upload" className="w-full">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="upload">Upload File</TabsTrigger>
            <TabsTrigger value="url">Video URL</TabsTrigger>
          </TabsList>
          <TabsContent value="upload">
            <div
              {...getRootProps()}
              className={`
                border-2 border-dashed rounded-lg p-8 text-center transition-colors
                ${isDragActive 
                  ? 'border-primary bg-primary/5' 
                  : 'border-muted-foreground/25 hover:border-primary/50'
                }
              `}
            >
              <input {...getInputProps()} />
              <div className="flex flex-col items-center gap-2">
                <Upload className="h-8 w-8 text-muted-foreground" />
                {file ? (
                  <p className="text-sm">Selected: {file.name}</p>
                ) : (
                  <>
                    <p className="text-sm text-muted-foreground">
                      Drag and drop a video file here, or click to select
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Supports MP4, MOV, AVI (max 100MB)
                    </p>
                  </>
                )}
              </div>
            </div>
          </TabsContent>
          <TabsContent value="url">
            <div className="space-y-2">
              <div className="flex gap-2">
                <Input
                  type="url"
                  placeholder="Enter video URL (e.g., https://example.com/video.mp4)"
                  value={url}
                  onChange={(e) => {
                    setUrl(e.target.value)
                    setFile(null)
                    setError(null)
                  }}
                />
                <LinkIcon className="h-4 w-4 text-muted-foreground self-center" />
              </div>
              <p className="text-xs text-muted-foreground">
                Enter a public URL to a video file (must end with .mp4, .mov, or .avi)
              </p>
            </div>
          </TabsContent>
        </Tabs>

        {error && (
          <div className="p-4 bg-destructive/10 border border-destructive text-destructive rounded-md">
            <p className="text-sm font-medium">Error: {error}</p>
          </div>
        )}

        <div className="flex flex-col gap-2">
          <Button
            onClick={handleProcess}
            disabled={processing || (!file && !url)}
            className="w-full"
          >
            {processing ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Processing...
              </>
            ) : (
              'Process Video'
            )}
          </Button>

          {processedUrl && (
            <Button
              variant="secondary"
              asChild
              className="w-full"
            >
              <a
                href={processedUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open Processed Audio
              </a>
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

