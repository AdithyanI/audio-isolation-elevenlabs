import requests
import time
import json

def test_audio_extraction():
    # URLs for the endpoints
    EXTRACT_URL = "https://wisdom-in-a-nutshell--video-processor-start-audio-extraction.modal.run"
    STATUS_URL = "https://wisdom-in-a-nutshell--video-processor-check-status.modal.run"
    
    # Test video URL
    video_url = "https://cache-aip-us.s3.us-east-1.amazonaws.com/processed-audio/original-videos/1733173125620-original-0u1ds4amped-Voice%20Isolator%20Demo.mp4"
    
    try:
        # 1. Start audio extraction
        print("\n1. Starting audio extraction...")
        response = requests.post(
            EXTRACT_URL,
            json={"video_url": video_url},
            headers={"Content-Type": "application/json"},
            timeout=30
        )
        
        response.raise_for_status()  # Raise an error for bad status codes
        
        result = response.json()
        job_id = result["job_id"]
        print(f"Started extraction. Job ID: {job_id}")
        print(f"Initial response: {json.dumps(result, indent=2)}")
        
        # 2. Poll for status
        print("\n2. Polling for status...")
        max_attempts = 20
        attempt = 0
        
        while attempt < max_attempts:
            try:
                status_response = requests.get(
                    f"{STATUS_URL}?job_id={job_id}",
                    timeout=30
                )
                
                if status_response.status_code != 200:
                    print(f"Error response ({status_response.status_code}): {status_response.text}")
                    if attempt == max_attempts - 1:
                        print("Max attempts reached with errors")
                        break
                else:
                    status = status_response.json()
                    print(f"Current status: {json.dumps(status, indent=2)}")
                    
                    if status["status"] == "error":
                        print("\nJob failed!")
                        break
                    elif status["status"] == "completed":
                        print("\nJob completed successfully!")
                        break
                
                attempt += 1
                if attempt == max_attempts:
                    print("\nMaximum polling attempts reached. Job might still be running.")
                    break
                
                print(f"Still processing... waiting 5 seconds (attempt {attempt}/{max_attempts})")
                time.sleep(5)
                
            except requests.exceptions.RequestException as e:
                print(f"Network error while polling status: {str(e)}")
                if attempt == max_attempts - 1:
                    print("Max attempts reached with network errors")
                    break
                time.sleep(5)
                continue
                
    except requests.exceptions.RequestException as e:
        print(f"Error making initial request: {str(e)}")
    except Exception as e:
        print(f"Unexpected error: {str(e)}")

if __name__ == "__main__":
    test_audio_extraction() 