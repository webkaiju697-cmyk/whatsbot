# scraper.py - Fixed with Extended Wait for API Responses
# The TweetDetail API response loads after initial page load
import asyncio
import os
import random
import json
import re
from collections import Counter, defaultdict
from playwright.async_api import async_playwright


def extract_screen_names_from_json(json_data) -> set:
    """
    Extract all screen_name values from JSON data using regex.
    """
    usernames = set()
    json_str = json.dumps(json_data) if isinstance(json_data, (dict, list)) else str(json_data)
    
    matches = re.findall(r'"screen_name"\s*:\s*"([^"]+)"', json_str)
    for name in matches:
        if name and not name.startswith(("i/", "search", "explore")):
            usernames.add(f"@{name}".lower())
    
    return usernames


async def scrape_single_tweet(context, tweet_url: str) -> set:
    """
    Scrapes a single tweet URL for all unique commenter handles by intercepting
    X.com's API responses. Uses extended wait to capture delayed TweetDetail responses.
    """
    usernames = set()
    page = await context.new_page()
    api_response_count = 0
    
    async def handle_response(response):
        """Intercept ALL JSON responses and extract screen_names."""
        nonlocal api_response_count
        try:
            url = response.url
            if ("x.com" in url or "twitter.com" in url) and response.status == 200:
                content_type = response.headers.get("content-type", "")
                if "json" in content_type:
                    try:
                        data = await response.json()
                        data_str = json.dumps(data)
                        
                        if "screen_name" in data_str:
                            api_response_count += 1
                            before = len(usernames)
                            new_names = extract_screen_names_from_json(data)
                            usernames.update(new_names)
                            added = len(usernames) - before
                            if added > 0:
                                print(f"📡 API #{api_response_count}: +{added} new names (total: {len(usernames)})")
                    except:
                        pass
        except:
            pass
    
    
    # 🕵️ DATA SAVING: Block heavy resources (images, media, fonts)
    async def block_heavy_resources(route):
        if route.request.resource_type in ["image", "media", "font"]:
            await route.abort()
        else:
            await route.continue_()
    await page.route("**/*", block_heavy_resources)

    page.on("response", handle_response)
    
    try:
        print(f"🌐 Loading: {tweet_url}")
        
        # Use domcontentloaded first to be faster, then wait manually for API responses
        await page.goto(tweet_url, wait_until="domcontentloaded", timeout=60000)
        
        # Wait for the page to fully load and initial API responses
        # INCREASED WAIT: Give 10s for initial load on slow networks
        print("⏳ Waiting 10s for initial API responses...")
        await asyncio.sleep(10)
        
        # Scroll to load comments - this triggers the TweetDetail API
        print("📜 Scrolling to load comments...")
        # Increased scroll attempts to ensures we go deep enough
        for i in range(10):  
            await page.evaluate("window.scrollBy(0, window.innerHeight)")
            await asyncio.sleep(random.uniform(2.0, 4.0))
        
        # Wait after scrolling for delayed API responses
        print("⏳ Waiting 8s for delayed API responses...")
        await asyncio.sleep(8)
        
        # 1. Click "Show probable spam" / sensitive content (Aggressive)
        print("🔘 Looking for 'Show probable spam' buttons...")
        for attempt in range(5): 
            try:
                # Specific selector for probable spam / offensive / sensitive
                spam_buttons = page.locator('text=/Show.*(probable|offensive|sensitive)/i')
                count = await spam_buttons.count()
                if count > 0:
                    print(f"🔘 Found {count} 'Show probable spam' buttons. Clicking...")
                    for i in range(count):
                        try:
                            if await spam_buttons.nth(i).is_visible():
                                await spam_buttons.nth(i).click(timeout=2000)
                                await asyncio.sleep(1)
                        except:
                            pass
                    await asyncio.sleep(5)
                else:
                    break
            except:
                break
        
        # 2. Click generic "Show more replies" (Conservative - Max 3 clicks)
        # This helps catch pagination or non-spam hidden replies without over-fetching 100s of comments
        print("🔘 Looking for generic 'Show more' buttons (limited)...")
        generic_clicks = 0
        for attempt in range(3):
            try:
                # Generic "Show more replies" or just "Show more"
                more_buttons = page.locator('text=/Show.*(more replies|replies)/i')
                if await more_buttons.count() > 0:
                    # Click only the first one found per attempt
                    if await more_buttons.first.is_visible():
                        print("🔘 Clicking generic 'Show more' button...")
                        await more_buttons.first.click(timeout=2000)
                        await asyncio.sleep(5) # Wait for load
                        generic_clicks += 1
                        if generic_clicks >= 3: # Hard limit
                            break
                else:
                    break
            except:
                break
        
        # Final wait for any remaining API responses
        await asyncio.sleep(5)
        
    except Exception as e:
        print(f"❌ Error loading page {tweet_url}: {e}")
    finally:
        await page.close()
    
    if usernames:
        print(f"✅ Extracted {len(usernames)} unique handles")
    else:
        print(f"⚠️ No handles were extracted from {tweet_url}")
    
    # Resolve the final URL to get the author handle (useful for /i/ status links)
    final_url = page.url
    author = "unknown"
    # Extract username from https://x.com/username/status/123
    author_match = re.search(r"(?:x\.com|twitter\.com)\/([a-zA-Z0-9_]+)\/status\/", final_url)
    if author_match:
        author = author_match.group(1).lower()

    return {"usernames": usernames, "author": author}


async def run_scrape_and_check(participant_ids: list, tweet_urls: list, target_usernames: list) -> str:
    """
    Orchestrates scraping and checking with case-insensitive matching.
    """
    all_auth_files = []
    for user_id in participant_ids:
        user_auth_dir = f"user_data/{user_id}/"
        if os.path.exists(user_auth_dir):
            all_auth_files.extend(
                [os.path.join(user_auth_dir, f) for f in os.listdir(
                    user_auth_dir) if f.endswith('.json')]
            )

    if not all_auth_files:
        return "❌ **Error:** No authentication files found for any of the raid participants. Cannot perform verification."

    found_handles_by_url = defaultdict(set)
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True, 
            args=["--disable-blink-features=AutomationControlled", "--no-sandbox"]
        )

        for i, url in enumerate(tweet_urls):
            auth_file_to_use = random.choice(all_auth_files)
            print(f"\n--- [{i+1}/{len(tweet_urls)}] Using auth: {auth_file_to_use} ---")

            context = await browser.new_context(storage_state=auth_file_to_use)
            handles_from_tweet = await scrape_single_tweet(context, url)
            found_handles_by_url[url] = handles_from_tweet
            await context.close()
        
        await browser.close()

    # --- CROSS-REFERENCING LOGIC ---
    user_comment_counts = Counter()
    for target_handle in target_usernames:
        target_handle_lower = target_handle.lower()

        for found_handles_set in found_handles_by_url.values():
            if target_handle_lower in found_handles_set:
                user_comment_counts[target_handle] += 1

    # --- REPORT GENERATION ---
    total_links_checked = len(tweet_urls)
    report = f"✅ **Verification Report** ✅\n\nChecked **{total_links_checked}** links. The following raid participants were found:\n\n"

    found_users = sorted(
        [handle for handle, count in user_comment_counts.items() if count > 0], 
        key=lambda x: user_comment_counts[x], 
        reverse=True
    )

    if found_users:
        for handle in found_users:
            count = user_comment_counts[handle]
            report += f" • `{handle}` - Commented on **{count} of {total_links_checked}** links.\n"
    else:
        report += "_None of the participants were found in the comments._\n"

    report += "\n"

    not_found_users = [
        handle for handle in target_usernames if user_comment_counts[handle] == 0]

    if not_found_users:
        report += f"❌ **Participants NOT Found:**\n"
        for handle in not_found_users:
            report += f" • `{handle}`\n"

    return report
