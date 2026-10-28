- If the quote's timer run out, the quote should disappear by itself. Right now I have to press the cancel button to make it disappear.
- On the User page, create a sub section of "receipts" Here the User should be able to see in beautiful and mdoern cards his history of receipts. These reciepts should hae all the details like how much user bought or sell, on which price, and how much his new balance was (gold and pkr respectively)
- Create a view toggle where the "Settings" section in the user page is hidden and displayed with a toggle button
- Add the #8ccb50 as the text color for PKR wallet, Your gold, and Platform inventory. The backgrounds of these (whihch are right now white) should be black
- Change the background color of "Market price · 24K" section to #8ccb50 and change it's text color to white.  


- The quote's behavior should be such that when the user creates a quote, the timer would start to tick down. During this time if the user cancels, the quote is expired. If the user does nothing, the quote is expired. However if the user clicks on the confirm button. The quote shouldn't close straight away. It should continue to tick down the timer and if the last choice of user was 'Confirm" then the quote would become a trade. Right now what happens is if i click the confirm button twice, the quote disappears on the second click. It shouldn't. However make sure that at the same time the quote is only created once regardless of how many times i click it.

- Refer to the "MobileDesign.png" to create the smaller screen/mobile screen design. I want it to be completely different from the desktop version.
- Pay attention to sections/divs widths. Right now there are multiple places where single line text is being divided into 2 lines.

- Goldprice.org is still being blocked by WAF on vercel. Is curl_cffi not working? Fix that as well. 
- Finally Change the background color of PKR wallet, Your Gold, and Platform Inventory to lime with the text's color being white.