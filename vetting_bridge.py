import sys
import json
import asyncio
import os
import random
from playwright.async_api import async_playwright
from scraper import scrape_single_tweet

# Constants
USER_DATA_DIR = "user_data"

async def vet_participants(target_links, participant_handles):
    """
    Scrapes target links for commenters and checks if participants are present.
    Returns a dictionary mapping participants to the links they missed.
    """
    
    # 1. Find available auth files
    auth_files = []
    if os.path.exists(USER_DATA_DIR):
        for user_id in os.listdir(USER_DATA_DIR):
            user_dir = os.path.join(USER_DATA_DIR, user_id)
            if os.path.isdir(user_dir):
                for f in os.listdir(user_dir):
                    if f.endswith(".json"):
                        auth_files.append(os.path.join(user_dir, f))
    
    if not auth_files:
        return {"error": "No auth files found in user_data"}

    # 2. Scrape each target link
    target_interactors = {}  # { url: set(usernames) }
    resolved_authors = {}    # { url: author_handle }
    
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            executable_path=os.getenv("PUPPETEER_EXECUTABLE_PATH")
        )
        
        # Redirect stdout to stderr to prevent scraper prints from corrupting JSON output
        original_stdout = sys.stdout
        sys.stdout = sys.stderr
        
        try:
            for url in target_links:
                success = False
                # Shallow copy so we can shuffle/rotate for each link if desired
                current_auth_attempts = list(auth_files)
                random.shuffle(current_auth_attempts)

                for auth_file in current_auth_attempts:
                    try:
                        context = await browser.new_context(storage_state=auth_file)
                        print(f"Scraping {url} with {auth_file}...", file=sys.stderr)
                        scraping_result = await scrape_single_tweet(context, url)
                        
                        interactors = scraping_result.get("usernames", set())
                        author = scraping_result.get("author", "unknown")
                        
                        if author == "unknown" and not interactors:
                            # Might be a block or CAPTCHA, try next account
                            print(f"Account {auth_file} failed to scrape {url} (Possible block/CAPTCHA). Trying next...", file=sys.stderr)
                            await context.close()
                            continue

                        target_interactors[url] = interactors
                        resolved_authors[url] = author
                        success = True
                        await context.close()
                        break # Success!
                    except Exception as e:
                        print(f"Error scraping {url} with {auth_file}: {e}", file=sys.stderr)
                        # Try next available account
                
                if not success:
                    print(f"CRITICAL: All accounts failed to scrape {url}", file=sys.stderr)
                    target_interactors[url] = set()
                    resolved_authors[url] = "unknown"
        finally:
            sys.stdout = original_stdout

        await browser.close()

    # 3. Check participants against scraped data
    # We use the resolved authors from the links as our definitive participant set
    # This solves the '/i/' link problem!
    results = {}
    
    # Get unique resolved authors (excluding unknown/i)
    participants_to_check = set(resolved_authors.values())
    if "unknown" in participants_to_check: participants_to_check.remove("unknown")
    if "i" in participants_to_check: participants_to_check.remove("i")

    for author in participants_to_check:
        normalized_handle = author.lower()
        missing_links = []
        for url, interactors in target_interactors.items():
            check_handle = f"@{normalized_handle}"
            if check_handle not in interactors:
                missing_links.append(url)
        
        results[author] = {
            "missing_count": len(missing_links),
            "missing_links": missing_links,
            "status": "compliant" if len(missing_links) == 0 else f"missing {len(missing_links)}"
        }

    return {
        "results": results,
        "resolved_authors": resolved_authors
    }

def main():
    try:
        # Read input from stdin
        input_data = sys.stdin.read()
        if not input_data:
            print(json.dumps({"error": "No input data provided"}))
            return

        request = json.loads(input_data)
        target_links = request.get("target_links", [])
        participant_handles = request.get("participant_handles", [])

        if not target_links:
            print(json.dumps({"error": "No target links provided"}))
            return

        # Run async loop
        results = asyncio.run(vet_participants(target_links, participant_handles))
        
        # Print results to stdout
        print(json.dumps(results))

    except Exception as e:
        print(json.dumps({"error": str(e)}))

if __name__ == "__main__":
    main()
